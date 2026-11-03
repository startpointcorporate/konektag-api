import pool from '../../infrastructure/database/pool.ts';
import {MerchantProSubscriptionService} from './merchant-pro-subscription-service.ts';
import {visibilityManager,visibilityId} from './visibility-shared.ts';

/** Public destination only. No SSO, merchant mapping or credentials are appended. */
export function erpNextCatalogUrl(value=process.env.ERPNEXT_CATALOG_URL):string|null {
  try{if(!value)return null;const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash?u.href:null;}catch{return null;}
}
export async function merchantCatalogAccess(actorId:string,merchantId:string){
  const merchant=await visibilityManager(actorId,visibilityId(merchantId));
  const {state}=await new MerchantProSubscriptionService(pool).resolveSubscription(merchantId);
  const hasPro=state==='ACTIVE';
  const url=hasPro?erpNextCatalogUrl():null;
  return {merchantProfileId:merchantId,businessName:merchant.business_name,hasPro,subscriptionState:state,
    state:hasPro?(url?'OPEN':'UNAVAILABLE'):'UPGRADE',url};
}
/** Explicit selection for legacy URLs with no establishment ID; never choose the default merchant silently. */
export async function catalogManagedMerchants(actorId:string){
 const {rows}=await pool.query(`SELECT mp.id,mp.business_name FROM konektag.merchant_profiles mp
 LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id=mp.id AND mm.user_id=$1
 WHERE mp.deleted_at IS NULL AND CASE WHEN mm.id IS NOT NULL THEN mm.status='active' AND mm.removed_at IS NULL AND mm.role IN ('owner','manager') ELSE mp.user_id=$1 END
 ORDER BY mp.business_name,mp.id`,[actorId]);return rows;
}
