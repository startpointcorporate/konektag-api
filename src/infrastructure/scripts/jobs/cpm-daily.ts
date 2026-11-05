#!/usr/bin/env node
/** Daily observational CPM import, using authenticated Meta/TikTok ad-account
 * reporting. No API claims universal country pricing; absence of delivered
 * ads => no observation. ERPNext's approved customer prices are unchanged.
 * Schedule via the existing Helm jobs map (opt-in after credential validation).
 */
import {createHash} from "node:crypto";
import pool from "../../database/pool.ts";
import {parseAccounts,marketOwner,observation,type CpmObservation,type AdAccountConfig} from "../../../application/services/cpm-market-service.ts";

type Raw={network:"facebook"|"instagram"|"tiktok";country:string;spend:number;impressions:number};
const day=process.env.CPM_OBSERVATION_DAY||new Date(Date.now()-86400000).toISOString().slice(0,10);
if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+"T12:00:00Z").toISOString().slice(0,10)!==day)
  throw new Error("CPM_OBSERVATION_DAY_INVALID");
const checkNumber=(v:unknown)=> {
 const n=Number(v);
 return v===null || v===undefined || v==="" || !Number.isFinite(n)?NaN:n;
};
const iso=(v:unknown)=>typeof v==="string"&&/^[A-Z]{2}$/.test(v)?v:"";
async function fetchJson(url:URL,headers:Record<string,string>):Promise<any>{
 if(!["graph.facebook.com","business-api.tiktok.com"].includes(url.hostname)||url.protocol!=="https:")
   throw new Error("CPM_PROVIDER_HOST_INVALID");
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000),redirect:"error"});
 if(!response.ok)throw new Error("CPM_PROVIDER_HTTP_"+response.status);
 return response.json();
}
async function meta(a:AdAccountConfig,token:string):Promise<Raw[]>{
 const rows:Raw[]=[];
 let url=new URL("https://graph.facebook.com/v24.0/act_"+a.accountId+"/insights");
 url.searchParams.set("fields","spend,impressions");
 url.searchParams.set("breakdowns","country,publisher_platform");
 url.searchParams.set("time_range",JSON.stringify({since:day,until:day}));
 url.searchParams.set("limit","500");
 for(let page=0;page<20;page++){
   const data=await fetchJson(url,{Authorization:"Bearer "+token});
   if(!Array.isArray(data.data))throw new Error("META_INSIGHTS_INVALID");
   for(const r of data.data){
     const network=r.publisher_platform;
     const country=iso(r.country);
     const spend=checkNumber(r.spend),impressions=checkNumber(r.impressions);
     if((network==="facebook"||network==="instagram")&&country&&
       Number.isFinite(spend)&&spend>=0&&Number.isSafeInteger(impressions)&&impressions>0)
       rows.push({network,country,spend,impressions});
   }
   if(!data.paging?.next)return rows;
   const next=new URL(data.paging.next);
   if(next.hostname!=="graph.facebook.com"||next.protocol!=="https:")throw new Error("META_PAGING_HOST_INVALID");
   url=next;
 }
 throw new Error("META_PAGING_LIMIT");
}
async function tiktok(a:AdAccountConfig,token:string):Promise<Raw[]>{
 const rows:Raw[]=[];
 for(let page=1;page<=50;page++){
   const url=new URL("https://business-api.tiktok.com/open_api/v2.0/report/integrated/get/");
   url.searchParams.set("report_type","BASIC");
   url.searchParams.set("data_level","AUCTION_ADVERTISER");
   url.searchParams.set("advertiser_ids",JSON.stringify([a.accountId]));
   url.searchParams.set("dimensions",JSON.stringify(["country_code"]));
   url.searchParams.set("metrics",JSON.stringify(["spend","impressions"]));
   url.searchParams.set("start_date",day);
   url.searchParams.set("end_date",day);
   url.searchParams.set("page",String(page));
   url.searchParams.set("page_size","1000");
   const payload=await fetchJson(url,{"Access-Token":token});
   if(payload.code!==0 || !Array.isArray(payload.data?.list))throw new Error("TIKTOK_REPORT_INVALID");
   const list=payload.data.list;
   for(const r of list){
     const country=iso(r.dimensions?.country_code||r.country_code);
     const spend=checkNumber(r.metrics?.spend??r.spend);
     const impressions=checkNumber(r.metrics?.impressions??r.impressions);
     if(country&&Number.isFinite(spend)&&spend>=0&&Number.isSafeInteger(impressions)&&impressions>0)
       rows.push({network:"tiktok",country,spend,impressions});
   }
   const total=Number(payload.data.page_info?.total_page||payload.data.page_info?.total_pages||page);
   if(page>=total||list.length<1000)return rows;
 }
 throw new Error("TIKTOK_PAGING_LIMIT");
}
async function main(){
 const accounts=parseAccounts(process.env.KONEKTAG_CPM_ACCOUNTS_JSON);
 if(!accounts.length)throw new Error("CPM_ACCOUNTS_NOT_CONFIGURED");
 const client=await pool.connect();
 let saved=0, skipped=0,failed=0;
 try{
  const locked=await client.query("SELECT pg_try_advisory_lock(hashtext('konektag-daily-cpm-observations')) AS ok");
  if(!locked.rows[0]?.ok)throw new Error("CPM_DAILY_ALREADY_RUNNING");
  try{
   for(const a of accounts){
    const token=process.env[a.tokenEnv];
    if(!token){failed++;console.error("[cpm-daily] missing provider token",{platform:a.platform,company:a.billingCompany});continue;}
    try{
     const source=a.platform==="meta"?"meta_ads_insights":"tiktok_ads_reporting";
     const data=a.platform==="meta"?await meta(a,token):await tiktok(a,token);
     const grouped=new Map<string,{spend:number;impressions:number;network:Raw["network"];country:string}>();
     for(const row of data){
       const key=row.country+":"+row.network;
       const curr=grouped.get(key)||{country:row.country,network:row.network,spend:0,impressions:0};
       curr.spend+=row.spend;curr.impressions+=row.impressions;grouped.set(key,curr);
     }
     const accountRef=createHash("sha256").update(a.platform+":"+a.accountId).digest("hex");
     for(const row of grouped.values()){
       const owner=await marketOwner(client,row.country).catch(()=>null);
       if(owner!==a.billingCompany){skipped++;continue;} // never cross-charge a foreign market
       const value=observation({
         billingCompany:a.billingCompany,platform:row.network,targetCountry:row.country,
         adAccountRef:accountRef,source,currency:a.currency,
         spend:Math.round(row.spend*1e6)/1e6,impressions:row.impressions,observationDay:day
       } as CpmObservation);
       if(!value){skipped++;continue;}
       await client.query(`INSERT INTO konektag.social_cpm_daily_observations
          (observation_day,billing_company,platform,target_country,ad_account_ref,source,currency,spend_major,impressions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(observation_day,billing_company,platform,target_country,ad_account_ref,source)
          DO UPDATE SET spend_major=EXCLUDED.spend_major,impressions=EXCLUDED.impressions,collected_at=now()`,
         [value.observationDay,value.billingCompany,value.platform,value.targetCountry,
          value.adAccountRef,value.source,value.currency,value.spend,value.impressions]);
       saved++;
     }
    }catch(error){failed++;console.error("[cpm-daily] provider batch failed",{
       platform:a.platform,company:a.billingCompany,code:error instanceof Error?error.message.slice(0,90):"UNKNOWN"
    });}
   }
  }finally{await client.query("SELECT pg_advisory_unlock(hashtext('konektag-daily-cpm-observations'))");}
 }finally{client.release();await pool.end();}
 console.info("[cpm-daily] completed",{day,accounts:accounts.length,saved,skipped,failed});
 if(failed)process.exitCode=1;
}
main().catch(error=>{console.error("[cpm-daily] aborted",error instanceof Error?error.message:"unknown");process.exitCode=1;});
