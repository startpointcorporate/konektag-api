import type {RouteHandler} from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import {countryCurrency} from '../../../application/services/country-currency-service.ts';
import {resolveTargetBoostCpm,convertBoostCpm} from '../../../application/services/merchant-social-boost-price-resolver.ts';
import {minorDecimal} from '../../../application/services/pay/money-unit.ts';

const CHANNELS=['facebook','instagram','tiktok'] as const;
const EUROPE=new Set(['FR','DE','BE','ES','IT','PT','NL','LU','AT','IE']);
function displayCurrency(code:string,source:string){
 if(code==='LB')return 'USD'; // Approved boost currency for Lebanon.
 if(EUROPE.has(code))return 'EUR';
 try{return countryCurrency(code).currency;}catch{return source;}
}
export const GET:RouteHandler=async()=>{
 try{
  const {rows}=await pool.query(`SELECT target_country AS code,max(target_country_name) AS name
   FROM konektag.merchant_social_boost_pricing
   WHERE is_active=TRUE AND channel=ANY($1::text[])
   GROUP BY target_country ORDER BY name`,[CHANNELS]);
  const countries:Array<{code:string;name:string;billingCompany:string;channels:Array<{channel:string;currency:string;cpm:number}>}>=[];
  const unavailableCountries:Array<{code:string;name:string;reason:string}>=[];
  for(const row of rows){
   const code=String(row.code).trim().toUpperCase(),name=String(row.name);
   const channels:Array<{channel:string;currency:string;cpm:number}>=[];
   let reason='CPM_NOT_CONFIGURED';
   let billingCompany='';
   for(const channel of CHANNELS){
    try{
     const result=await resolveTargetBoostCpm(channel,code);
     const currency=displayCurrency(code,result.currency);
     const converted=await convertBoostCpm(result.cpmMinor,result.currency,currency);
     const cpm=Number(minorDecimal(converted,currency));
     if(!Number.isFinite(cpm)||cpm<=0)throw Error('INVALID_CPM');
     if(billingCompany&&billingCompany!==result.company)throw Error('CROSS_COMPANY_MARKET');
     billingCompany=result.company;
     channels.push({channel,currency,cpm});
    }catch(error){
     reason=error&&typeof error==='object'&&'code' in error?String(error.code):'CPM_RESOLUTION_FAILED';
     console.warn('[public-boost-cpm] channel unavailable',{country:code,channel,reason});
    }
   }
   // A country with at least one verified network remains eligible.
   // Never require an unrelated channel's ERPNext mapping to exist.
   if(channels.length>0&&billingCompany)countries.push({code,name,billingCompany,channels});
   else unavailableCountries.push({code,name,reason});
  }
  // Aggregate by the verified owning Konektag company, not the buyer country.
  const marketMap=new Map<string,Array<{code:string;name:string;channels:Array<{channel:string;currency:string;cpm:number}>}>>();
  for(const country of countries){
    const group=marketMap.get(country.billingCompany)||[];
    group.push({code:country.code,name:country.name,channels:country.channels});
    marketMap.set(country.billingCompany,group);
  }
  const markets=[...marketMap.entries()].map(([billingCompany,targetCountries])=>({billingCompany,targetCountries}));
  return new Response(JSON.stringify({countries,markets,unavailableCountries,estimated:true,guaranteed:false}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=60'}});
 }catch(error){
  console.error('[public-boost-cpm] failed',error);
  return new Response(JSON.stringify({error:'CPM_SERVICE_UNAVAILABLE'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 }
};
