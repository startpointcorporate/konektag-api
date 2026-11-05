import type {RouteHandler} from "../../http";
import pool from "../../../infrastructure/database/pool.ts";

// Public estimates are indicative commercial CPM ranges, not ERPNext invoice prices.
// Only markets with exactly one active billing owner can be advertised.
// Ranges older than two months are not offered to customers.
export const GET:RouteHandler=async()=>{
 try{
  const {rows}=await pool.query(`WITH active_markets AS (
    SELECT target_country, MIN(billing_company) AS billing_company
    FROM konektag.merchant_social_boost_pricing
    WHERE is_active=TRUE AND billing_company IS NOT NULL
    GROUP BY target_country
    HAVING COUNT(DISTINCT billing_company)=1
  ), latest AS (
    SELECT DISTINCT ON (r.target_country,r.network)
      r.target_country AS code,r.target_country_name AS name,r.network AS channel,
      r.billing_company AS "billingCompany",r.currency,
      r.cpm_low::float8 AS "cpmLow",r.cpm_high::float8 AS "cpmHigh",
      to_char(r.month,'YYYY-MM') AS "referenceMonth",
      ((EXTRACT(YEAR FROM age(date_trunc('month', CURRENT_DATE),r.month))::int * 12)
       + EXTRACT(MONTH FROM age(date_trunc('month', CURRENT_DATE),r.month))::int) AS "ageMonths"
    FROM konektag.social_cpm_monthly_ranges r
    JOIN active_markets m ON m.target_country=r.target_country
      AND m.billing_company=r.billing_company
    WHERE r.month <= date_trunc('month',CURRENT_DATE)::date
      AND r.month >= (date_trunc('month',CURRENT_DATE)-INTERVAL '2 months')::date
    ORDER BY r.target_country,r.network,r.month DESC
  )
  SELECT latest.* FROM latest
  JOIN konektag.merchant_social_boost_pricing mapping
    ON mapping.target_country=latest.code
   AND mapping.channel=latest.channel
   AND mapping.billing_company=latest."billingCompany"
   AND mapping.is_active=TRUE
  GROUP BY latest.code,latest.name,latest.channel,latest."billingCompany",
           latest.currency,latest."cpmLow",latest."cpmHigh",
           latest."referenceMonth",latest."ageMonths"
  ORDER BY latest.name,latest.channel`);
  const byCountry=new Map<string,{code:string;name:string;billingCompany:string;channels:Array<{
    channel:string;currency:string;cpmLow:number;cpmHigh:number;referenceMonth:string;stale:boolean
  }> }>();
  const owners=new Map<string,string>();
  for(const row of rows){
    const code=String(row.code).trim(),company=String(row.billingCompany);
    if(owners.has(code)&&owners.get(code)!==company)throw Error("CPM_MARKET_OWNER_CONFLICT");
    owners.set(code,company);
    const low=Number(row.cpmLow),high=Number(row.cpmHigh),ageMonths=Number(row.ageMonths);
    if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<low
      ||!Number.isInteger(ageMonths)||ageMonths<0||ageMonths>2)
      throw Error("CPM_RANGE_INVALID");
    let item=byCountry.get(code);
    if(!item){item={code,name:String(row.name),billingCompany:company,channels:[]};byCountry.set(code,item);}
    item.channels.push({channel:String(row.channel),currency:String(row.currency),
      cpmLow:low,cpmHigh:high,referenceMonth:String(row.referenceMonth),stale:ageMonths===2});
  }
  const countries=[...byCountry.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const ownersByCompany=new Map<string,typeof countries>();
  for(const c of countries){
    const group=ownersByCompany.get(c.billingCompany)||[];
    group.push(c);ownersByCompany.set(c.billingCompany,group);
  }
  const markets=[...ownersByCompany.entries()].map(([billingCompany,targetCountries])=>({billingCompany,targetCountries}));
  return new Response(JSON.stringify({countries,markets,estimated:true,guaranteed:false}),
   {headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=60"}});
 }catch(error){
  console.error("[public-boost-cpm] monthly range query failed",error instanceof Error?error.message:"UNKNOWN");
  return new Response(JSON.stringify({error:"CPM_SERVICE_UNAVAILABLE"}),
   {status:503,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 }
};
