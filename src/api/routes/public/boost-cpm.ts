import type {RouteHandler} from "../../http";
import pool from "../../../infrastructure/database/pool.ts";

// The public simulator uses monthly operator-approved ranges. Actual quotes
// and invoices continue using ERPNext Item Prices (separate business contract).
// Never invent rates or infer the legal owner from customer location.
export const GET:RouteHandler=async()=>{
 try{
  const {rows}=await pool.query(`SELECT DISTINCT ON (r.target_country,r.network)
    r.target_country AS code,r.target_country_name AS name,r.network AS channel,
    r.billing_company AS "billingCompany",r.currency,
    r.cpm_low::float8 AS "cpmLow",r.cpm_high::float8 AS "cpmHigh",
    to_char(r.month,'YYYY-MM') AS "referenceMonth"
   FROM konektag.social_cpm_monthly_ranges r
   WHERE r.month <= date_trunc('month',CURRENT_DATE)::date
   ORDER BY r.target_country,r.network,r.month DESC`);
  const byCountry=new Map<string,{code:string;name:string;billingCompany:string;channels:Array<{
    channel:string;currency:string;cpmLow:number;cpmHigh:number;referenceMonth:string
  }> }>();
  const owners=new Map<string,string>();
  for(const row of rows){
    const code=String(row.code).trim(),company=String(row.billingCompany);
    if(owners.has(code)&&owners.get(code)!==company)
      throw Error("CPM_MARKET_OWNER_CONFLICT");
    owners.set(code,company);
    const low=Number(row.cpmLow),high=Number(row.cpmHigh);
    if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<low)
      throw Error("CPM_RANGE_INVALID");
    let item=byCountry.get(code);
    if(!item){item={code,name:String(row.name),billingCompany:company,channels:[]};byCountry.set(code,item);}
    item.channels.push({channel:String(row.channel),currency:String(row.currency),
      cpmLow:low,cpmHigh:high,referenceMonth:String(row.referenceMonth)});
  }
  const countries=[...byCountry.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const ownersByCompany=new Map<string,typeof countries>();
  for(const c of countries){
    const group=ownersByCompany.get(c.billingCompany)||[];
    group.push(c);ownersByCompany.set(c.billingCompany,group);
  }
  const markets=[...ownersByCompany.entries()].map(([billingCompany,targetCountries])=>({billingCompany,targetCountries}));
  return Response.json({countries,markets,estimated:true,guaranteed:false},
   {headers:{"Cache-Control":"public, max-age=60"}});
 }catch(error){
  console.error("[public-boost-cpm] monthly range query failed",error instanceof Error?error.message:"UNKNOWN");
  return Response.json({error:"CPM_SERVICE_UNAVAILABLE"},{status:503,headers:{"Cache-Control":"no-store"}});
 }
};
