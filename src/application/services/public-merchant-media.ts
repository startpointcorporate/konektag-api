import pool from '../../infrastructure/database/pool.ts';
import {publicMarketplaceCtes} from './public-marketplace-sql.ts';

export async function canReadMerchantMedia(key:string,actorId?:string):Promise<boolean> {
 const match=key.match(/^merchant\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/[^/]+$/i);
 if(!match)return false;
 const id=match[1];
 if(actorId){
  const {rows}=await pool.query(`SELECT 1 FROM konektag.merchant_profiles mp WHERE mp.id=$1 AND mp.deleted_at IS NULL
   AND CASE WHEN EXISTS(SELECT 1 FROM konektag.merchant_memberships mm WHERE mm.merchant_profile_id=mp.id AND mm.user_id=$2)
   THEN EXISTS(SELECT 1 FROM konektag.merchant_memberships mm WHERE mm.merchant_profile_id=mp.id AND mm.user_id=$2
     AND mm.status='active' AND mm.role IN ('owner','manager') AND mm.removed_at IS NULL)
   ELSE mp.user_id=$2 END`,[id,actorId]);
  if(rows.length)return true;
 }
 const mediaUrl='/api/merchant/media-file?key='+encodeURIComponent(key);
 const {rows}=await pool.query(`${publicMarketplaceCtes}
 SELECT 1 FROM public_n2 n2 WHERE n2.merchant_profile_id=$1
 AND (jsonb_path_exists(n2.snapshot,'$.** ? (@ == $url)',jsonb_build_object('url',$2::text))
 OR EXISTS(SELECT 1 FROM public_n3 n3 WHERE n3.merchant_profile_id=n2.merchant_profile_id
 AND jsonb_path_exists(jsonb_build_object('merchant',n3.snapshot->'merchant','activity',n3.snapshot->'activity','media',n3.snapshot->'media'),'$.** ? (@ == $url)',jsonb_build_object('url',$2::text)))
 OR EXISTS(SELECT 1 FROM public_products p WHERE p.merchant_profile_id=n2.merchant_profile_id
 AND COALESCE(p.catalog_metadata->>'status','active')='active' AND COALESCE(p.catalog_metadata->>'visibility','public')='public'
 AND jsonb_path_exists(to_jsonb(p),'$.** ? (@ == $url)',jsonb_build_object('url',$2::text))))`,[id,mediaUrl]);
 return rows.length>0;
}
