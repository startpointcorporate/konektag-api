import type {RouteHandler} from "../../http";
import pool from "../../../infrastructure/database/pool.ts";

// CPM catalogue is a READ-ONLY PostgreSQL projection of three independent
// ERPNext sites. No runtime calls to Frappe or ERPNext are permitted here.
// Supported: ?country=CG, ?network=facebook, ?groupBy=country|network.
export const GET:RouteHandler=async context=>{
 const country=context?.url?.searchParams.get("country")?.trim().toUpperCase()||null;
 const network=context?.url?.searchParams.get("network")?.trim().toLowerCase()||null;
 const groupBy=context?.url?.searchParams.get("groupBy")||"country";
 if(country && !/^[A-Z]{2}$/.test(country) ||
    network && !["facebook","instagram","tiktok"].includes(network) ||
    !["country","network"].includes(groupBy))
   return Response.json({error:"INVALID_CPM_FILTER"},{status:400,headers:{"Cache-Control":"no-store"}});
 try{
  const {rows}=await pool.query(`WITH latest AS (
    SELECT DISTINCT ON (r.target_country,r.network)
      r.target_country AS code,r.target_country_name AS name,r.network AS channel,
      s.billing_company AS "billingCompany",s.source_site AS "erpnextSite",
      r.item_code AS "itemCode",r.currency,
      r.cpm_low::float8 AS "cpmLow",r.cpm_high::float8 AS "cpmHigh",
      to_char(r.month,'YYYY-MM') AS "referenceMonth",
      ((EXTRACT(YEAR FROM age(date_trunc('month',CURRENT_DATE),r.month))::int * 12)
       + EXTRACT(MONTH FROM age(date_trunc('month',CURRENT_DATE),r.month))::int) AS "ageMonths"
    FROM konektag.social_cpm_monthly_ranges r
    JOIN konektag.cpm_source_sites s
      ON s.source_site=r.source_site AND s.billing_company=r.billing_company
     AND s.target_country=r.target_country AND s.currency=r.currency AND s.is_active=TRUE
    WHERE r.is_active=TRUE
      AND r.month <= date_trunc('month',CURRENT_DATE)::date
      AND r.month >= (date_trunc('month',CURRENT_DATE)-INTERVAL '2 months')::date
      AND ($1::text IS NULL OR r.target_country=$1)
      AND ($2::text IS NULL OR r.network=$2)
    ORDER BY r.target_country,r.network,r.month DESC
  )
  SELECT * FROM latest ORDER BY name,channel`,[country,network]);
  type Channel={channel:string;currency:string;cpmLow:number;cpmHigh:number;referenceMonth:string;
    stale:boolean;itemCode:string;erpnextSite:string};
  type Country={code:string;name:string;billingCompany:string;channels:Channel[]};
  const byCountry=new Map<string,Country>();
  const byNetwork=new Map<string,{network:string;targetCountries:Array<{
    code:string;name:string;billingCompany:string;currency:string;
    cpmLow:number;cpmHigh:number;referenceMonth:string;stale:boolean;itemCode:string;erpnextSite:string
  }> }>();
  for(const row of rows){
    const code=String(row.code).trim(),company=String(row.billingCompany);
    const low=Number(row.cpmLow),high=Number(row.cpmHigh),ageMonths=Number(row.ageMonths);
    if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<low||
      !Number.isInteger(ageMonths)||ageMonths<0||ageMonths>2)throw Error("CPM_RANGE_INVALID");
    let c=byCountry.get(code);
    if(!c){c={code,name:String(row.name),billingCompany:company,channels:[]};byCountry.set(code,c);}
    if(c.billingCompany!==company)throw Error("CPM_MARKET_OWNER_CONFLICT");
    const channel=String(row.channel);
    const info:Channel={channel,currency:String(row.currency),cpmLow:low,cpmHigh:high,
      referenceMonth:String(row.referenceMonth),stale:ageMonths===2,
      itemCode:String(row.itemCode),erpnextSite:String(row.erpnextSite)};
    c.channels.push(info);
    let n=byNetwork.get(channel);
    if(!n){n={network:channel,targetCountries:[]};byNetwork.set(channel,n);}
    n.targetCountries.push({code,name:c.name,billingCompany:company,
      currency:info.currency,cpmLow:low,cpmHigh:high,referenceMonth:info.referenceMonth,
      stale:info.stale,itemCode:info.itemCode,erpnextSite:info.erpnextSite});
  }
  const countries=[...byCountry.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const markets=[...new Set(countries.map(c=>c.billingCompany))].sort().map(billingCompany=>({
    billingCompany,targetCountries:countries.filter(c=>c.billingCompany===billingCompany)
  }));
  const networks=[...byNetwork.values()].sort((a,b)=>a.network.localeCompare(b.network));
  return Response.json({countries,networks,markets,groupBy,estimated:true,guaranteed:false},
   {headers:{"Cache-Control":"public, max-age=60"}});
 }catch(error){
  console.error("[public-boost-cpm] postgres projection query failed",error instanceof Error?error.message:"UNKNOWN");
  return Response.json({error:"CPM_SERVICE_UNAVAILABLE"},
   {status:503,headers:{"Cache-Control":"no-store"}});
 }
};
