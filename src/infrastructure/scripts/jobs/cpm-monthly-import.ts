#!/usr/bin/env node
/** Import a human-approved CPM range file once per month.
 * Usage: node dist/jobs/cpm-monthly-import.mjs /path/cpm-2026-11.json [--apply]
 * Default is audit/dry-run. No Meta/TikTok token, no ERPNext price mutation.
 */
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import pool from "../../database/pool.ts";

type Rate={billingCompany:string;targetCountry:string;countryName:string;network:"facebook"|"instagram"|"tiktok";currency:string;cpmLow:number;cpmHigh:number};
const code2=/^[A-Z]{2}$/, code3=/^[A-Z]{3}$/;
export function validateMonthlyFile(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("CPM_FILE_INVALID");
  const o=value as Record<string,unknown>;
  if(typeof o.month!=="string"||!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.month))throw Error("CPM_MONTH_INVALID");
  if(!Array.isArray(o.rates)||o.rates.length<1||o.rates.length>5000)throw Error("CPM_RATES_INVALID");
  const keys=new Set<string>(),owners=new Map<string,string>();
  const rates:Rate[]=o.rates.map((entry:unknown)=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw Error("CPM_RATE_INVALID");
    const r=entry as Record<string,unknown>;
    const keysRequired=["billingCompany","targetCountry","countryName","network","currency","cpmLow","cpmHigh"];
    if(Object.keys(r).some(k=>!keysRequired.includes(k))||keysRequired.some(k=>!(k in r)))throw Error("CPM_RATE_FIELDS_INVALID");
    const {billingCompany,targetCountry,countryName,network,currency,cpmLow,cpmHigh}=r;
    if(typeof billingCompany!=="string"||billingCompany.trim()!==billingCompany||billingCompany.length<2||billingCompany.length>140||
       typeof countryName!=="string"||!countryName.trim()||countryName.length>120||
       typeof targetCountry!=="string"||!code2.test(targetCountry)||
       !["facebook","instagram","tiktok"].includes(String(network))||
       typeof currency!=="string"||!code3.test(currency)||
       typeof cpmLow!=="number"||!Number.isFinite(cpmLow)||cpmLow<=0||
       typeof cpmHigh!=="number"||!Number.isFinite(cpmHigh)||cpmHigh<cpmLow||
       !Number.isFinite(cpmLow*1e6)||!Number.isFinite(cpmHigh*1e6)||cpmHigh>1000000000)
      throw Error("CPM_RATE_INVALID");
    const key=targetCountry+":"+network;
    if(keys.has(key))throw Error("CPM_DUPLICATE_COUNTRY_NETWORK");keys.add(key);
    const owner=owners.get(targetCountry);
    if(owner&&owner!==billingCompany)throw Error("CPM_MARKET_OWNER_CONFLICT");
    owners.set(targetCountry,billingCompany);
    return {billingCompany,targetCountry,countryName,network,currency,cpmLow,cpmHigh} as Rate;
  });
  return {month:o.month,rates};
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length<1||args.length>2||args.some(a=>a.startsWith("--")&&a!=="--apply"))
    throw Error("Usage: cpm-monthly-import <absolute-json-path> [--apply]");
  const file=args.find(a=>a!=="--apply")!;
  if(!file.startsWith("/"))throw Error("CPM_ABSOLUTE_PATH_REQUIRED");
  const apply=args.includes("--apply");
  const contents=await readFile(file,"utf8");
  if(contents.length>1024*1024)throw Error("CPM_FILE_TOO_LARGE");
  const parsed=validateMonthlyFile(JSON.parse(contents));
  const sha=createHash("sha256").update(contents).digest("hex");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('konektag-monthly-cpm-import'))");
    // Existing mappings are commercial ownership authority; imported CPM
    // ranges never create merchant mappings, ERPNext Items or price lists.
    const {rows:owned}=await client.query(`SELECT target_country, array_agg(DISTINCT billing_company) AS owners
      FROM konektag.merchant_social_boost_pricing
      WHERE is_active=TRUE AND billing_company IS NOT NULL
      GROUP BY target_country`);
    const mappings=new Map(owned.map((r:any)=>[String(r.target_country).trim(),r.owners as string[]]));
    for(const rate of parsed.rates){
      const list=mappings.get(rate.targetCountry);
      if(!list||list.length!==1||list[0]!==rate.billingCompany)
        throw Error("CPM_OWNER_MISMATCH:"+rate.targetCountry);
    }
    const month=parsed.month+"-01";
    const {rows:existing}=await client.query(`SELECT DISTINCT source_file_sha256
       FROM konektag.social_cpm_monthly_ranges WHERE month=$1`,[month]);
    if(existing.length && (existing.length!==1||existing[0].source_file_sha256!==sha))
      throw Error("CPM_MONTH_ALREADY_IMPORTED_DIFFERENT_FILE");
    if(apply && !existing.length){
      for(const r of parsed.rates){
        await client.query(`INSERT INTO konektag.social_cpm_monthly_ranges
          (month,billing_company,target_country,target_country_name,network,currency,cpm_low,cpm_high,source_file_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [month,r.billingCompany,r.targetCountry,r.countryName,r.network,r.currency,r.cpmLow,r.cpmHigh,sha]);
      }
    }
    await client.query(apply?"COMMIT":"ROLLBACK");
    console.info(JSON.stringify({mode:apply?"apply":"audit",month:parsed.month,rows:parsed.rates.length,
      markets:[...new Set(parsed.rates.map(r=>r.billingCompany))].length,sha256:sha,
      status:existing.length?"already_imported":apply?"imported":"validated"}));
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();await pool.end();}
}
if(process.argv[1]?.endsWith("cpm-monthly-import.mjs"))main().catch(e=>{
 console.error("[cpm-monthly-import]",e instanceof Error?e.message:"UNKNOWN");process.exitCode=1;
});
