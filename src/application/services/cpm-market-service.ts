/**
 * CPM observation contracts. Marketplace ownership is explicit in existing
 * merchant_social_boost_pricing mappings; never derive it from buyer country.
 * Historic ad-account costs never overwrite approved ERPNext Item Prices.
 */
export type Network = "facebook" | "instagram" | "tiktok";
export interface AdAccountConfig {
  billingCompany: string;
  platform: "meta" | "tiktok";
  accountId: string;
  tokenEnv: string;
  currency: string;
}
export interface CpmObservation {
  billingCompany: string;
  platform: Network;
  targetCountry: string;
  adAccountRef: string;
  source: "meta_ads_insights" | "tiktok_ads_reporting";
  currency: string;
  spend: number;
  impressions: number;
  observationDay: string;
}
const code2=/^[A-Z]{2}$/, currency3=/^[A-Z]{3}$/;
const tokenName=/^KONEKTAG_CPM_(META|TIKTOK)_[A-Z0-9_]+_TOKEN$/;
export function parseAccounts(raw: string | undefined): AdAccountConfig[] {
  if (!raw) return [];
  let json:unknown;
  try { json=JSON.parse(raw); } catch { throw new Error("CPM_CONFIG_INVALID_JSON"); }
  if (!Array.isArray(json) || json.length>50) throw new Error("CPM_ACCOUNTS_INVALID");
  const seen=new Set<string>();
  return json.map((a:unknown)=>{
    if (!a || typeof a!=="object" || Array.isArray(a)) throw new Error("CPM_ACCOUNT_INVALID");
    const v=a as Record<string,unknown>;
    if (typeof v.billingCompany!=="string"||!v.billingCompany.trim()||v.billingCompany.length>140 ||
      !["meta","tiktok"].includes(String(v.platform)) ||
      typeof v.accountId!=="string"||!/^[0-9]{3,30}$/.test(v.accountId) ||
      typeof v.tokenEnv!=="string"||!tokenName.test(v.tokenEnv) ||
      !currency3.test(String(v.currency))) throw new Error("CPM_ACCOUNT_INVALID");
    if ((v.platform==="meta"&&!v.tokenEnv.startsWith("KONEKTAG_CPM_META_")) ||
        (v.platform==="tiktok"&&!v.tokenEnv.startsWith("KONEKTAG_CPM_TIKTOK_")))
      throw new Error("CPM_ACCOUNT_TOKEN_FAMILY_INVALID");
    const key=v.platform+":"+v.accountId;
    if (seen.has(key)) throw new Error("CPM_ACCOUNT_DUPLICATE");
    seen.add(key);
    return {billingCompany:v.billingCompany.trim(),platform:v.platform as "meta"|"tiktok",
      accountId:v.accountId,tokenEnv:v.tokenEnv,currency:v.currency as string};
  });
}
export function observation(input: CpmObservation): CpmObservation | null {
  if (!input.billingCompany || !["facebook","instagram","tiktok"].includes(input.platform) ||
      !code2.test(input.targetCountry) || !currency3.test(input.currency) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.observationDay) ||
      !/^[a-f0-9]{64}$/.test(input.adAccountRef) ||
      !Number.isFinite(input.spend) || input.spend<0 || !Number.isSafeInteger(input.impressions) ||
      input.impressions<=0) return null;
  return input;
}
export function weightedCpm(records: Array<{spend:number;impressions:number;currency:string}>){
  if (!records.length || new Set(records.map(r=>r.currency)).size!==1 ||
      records.some(r=>!Number.isFinite(r.spend)||r.spend<0||!Number.isSafeInteger(r.impressions)||r.impressions<=0)) return null;
  const spend=records.reduce((n,r)=>n+r.spend,0);
  const impressions=records.reduce((n,r)=>n+r.impressions,0);
  if(!Number.isFinite(spend)||!Number.isSafeInteger(impressions)||impressions<1000)return null;
  return {cpm:Math.round((1000*spend/impressions)*1e6)/1e6,
    spend,impressions,currency:records[0].currency};
}
/** Return exactly one configured owner or refuse an ambiguous/undefined market. */
export async function marketOwner(db: {query:(sql:string,args:unknown[])=>Promise<{rows:Array<{billing_company:string}>}>},
 targetCountry:string):Promise<string>{
  if(!code2.test(targetCountry))throw new Error("CPM_TARGET_INVALID");
  const {rows}=await db.query(`SELECT DISTINCT billing_company FROM konektag.merchant_social_boost_pricing
     WHERE target_country=$1 AND is_active=TRUE AND billing_company IS NOT NULL
     ORDER BY billing_company`,[targetCountry]);
  if(rows.length!==1)throw new Error(rows.length?"CPM_MARKET_AMBIGUOUS":"CPM_MARKET_UNASSIGNED");
  return rows[0].billing_company;
}
