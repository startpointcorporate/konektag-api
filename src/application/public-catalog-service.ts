import { normalizeLocale } from './shared/i18n.ts';
import { marketplaceSlug } from './shared/marketplace/slug.ts';
import pool from '../infrastructure/database/pool.ts';
import { publicMarketplaceCtes } from './services/public-marketplace-sql.ts';
import { requireCoreMerchantActor, resolveLines } from './core-transaction-service.ts';
import { listActivePromotions } from './promotion-service.ts';
import { CartSchema, ReelSchema, catalogPath } from '../domain/public-catalog.ts';
import { z } from 'zod';
export const publicProductSql = `p.deleted_at IS NULL AND COALESCE(p.catalog_metadata->>'status','active')='active' AND COALESCE(p.catalog_metadata->>'visibility','public')='public'`;
// Live rows may revoke visibility, but only the snapshot supplies public content.
const catalogProductSql = `${publicProductSql} AND EXISTS (SELECT 1 FROM konektag.merchant_products live WHERE live.id=p.id AND live.merchant_profile_id=p.merchant_profile_id AND ${publicProductSql.replaceAll('p.', 'live.')})`;
export function categorySql(parameter: string) { return `(
  EXISTS (SELECT 1 FROM konektag.marketplace_merchant_activities mma
          WHERE mma.merchant_profile_id=mp.id AND mma.status IN ('Published','Referenced')
            AND lower(mma.activity_code)=lower(${parameter}))
  OR EXISTS (
    SELECT 1 FROM public_products p
    JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.deleted_at IS NULL
    WHERE p.merchant_profile_id=mp.id AND ${publicProductSql}
      AND (lower(oc.code)=lower(${parameter}) OR lower(oc.name_i18n::text) LIKE '%'||lower(${parameter})||'%')
  )
)`; }
export async function publicCatalog(merchantId: string) {
  if (!z.string().uuid().safeParse(merchantId).success) return null;
  const { rows: [merchant] } = await pool.query(`${publicMarketplaceCtes} SELECT merchant_profile_id AS id,snapshot->'merchant'->>'businessName' AS business_name,snapshot->'merchant'->>'slug' AS slug,snapshot->'merchant'->>'city' AS city FROM public_n2 WHERE merchant_profile_id=$1`,[merchantId]);
  if (!merchant) return null;
  const { rows: products } = await pool.query(`${publicMarketplaceCtes} SELECT p.id,p.name,p.description,p.offer_category_id,p.offer_subcategory_id,oc.code AS category,oc.name_i18n AS category_name_i18n,osc.code AS subcategory,osc.name_i18n AS subcategory_name_i18n,p.catalog_metadata,
    COALESCE((SELECT json_agg(json_build_object('id',r.id,'unitPrice',r.unit_price,'currency',r.currency,'minQuantity',r.min_quantity,'maxQuantity',r.max_quantity) ORDER BY r.id)
      FROM konektag.product_pricing_rules r WHERE r.merchant_product_id=p.id AND r.merchant_profile_id=p.merchant_profile_id AND r.deleted_at IS NULL AND r.status='APPROVED' AND r.valid_from<=CURRENT_DATE AND (r.valid_until IS NULL OR r.valid_until>=CURRENT_DATE)),'[]') AS prices,
    COALESCE((SELECT json_agg(json_build_object('id',m.id,'url',m."fileUrl",'type',m."mediaType",'title',m.title) ORDER BY m."displayOrder",m.id)
      FROM public_n3 n3 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n3.snapshot->'media','[]'::jsonb)) item CROSS JOIN LATERAL jsonb_to_record(item) AS m(id text,"fileUrl" text,"mediaType" text,title text,"displayOrder" int) WHERE n3.merchant_profile_id=p.merchant_profile_id AND n3.activity_code=p.activity_code AND m."mediaType" IN ('Image','Video') AND (p.catalog_metadata->'mediaIds') ? m.id),'[]') AS media
    FROM public_products p JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.deleted_at IS NULL LEFT JOIN konektag.offer_subcategories osc ON osc.id=p.offer_subcategory_id AND osc.deleted_at IS NULL WHERE p.merchant_profile_id=$1 AND ${catalogProductSql} ORDER BY p.display_order,p.id`,[merchantId]);
  const promotions = await listActivePromotions(pool as any,merchantId);
  return {merchant, products: products.map(p=>({...p,promotions: promotions.filter(x=>x.category.toLowerCase()==='general'||x.category.toLowerCase()===(p.category||'').toLowerCase())}))};
}
export async function quoteCatalog(input: unknown) {
  const cart=CartSchema.parse(input); const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[merchant]}=await client.query(`SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR SHARE`,[cart.merchantProfileId]);
    if (!merchant) throw new Error('NOT_FOUND');
    const {rows}=await client.query(`${publicMarketplaceCtes} SELECT p.id FROM public_products p WHERE p.merchant_profile_id=$1 AND p.id=ANY($2::uuid[]) AND ${catalogProductSql}`,[cart.merchantProfileId,cart.lines.map(l=>l.offerId)]);
    if (new Set(cart.lines.map(l=>l.offerId)).size!==rows.length) throw new Error('INVALID_CATALOG_PRODUCT');
    const quote=await resolveLines(client,{merchantProfileId:cart.merchantProfileId,customerUserId:null,kind:'ORDER',requestKey:'quote',catalogCheckout:true,lines:cart.lines.map(l=>({...l,label:'Catalogue'}))});
    await client.query('COMMIT'); return quote;
  } catch(e) {await client.query('ROLLBACK');throw e;} finally{client.release();}
}
export async function saveReel(actorId: string, input: unknown) {
  const reel=ReelSchema.parse(input), client=await pool.connect();
  try {
    await client.query('BEGIN'); await requireCoreMerchantActor(client,reel.merchantProfileId,actorId);
    if (reel.productId) {
      const {rowCount}=await client.query(`SELECT id FROM konektag.merchant_products WHERE id=$1 AND merchant_profile_id=$2 AND deleted_at IS NULL FOR SHARE`,[reel.productId,reel.merchantProfileId]);
      if(!rowCount)throw new Error('INVALID_PRODUCT');
    }
    const ids=[...new Set(reel.mediaIds)];
    const {rowCount}=await client.query(`SELECT id FROM konektag.merchant_media WHERE id=ANY($1::uuid[]) AND merchant_profile_id=$2 AND deleted_at IS NULL AND media_type IN ('Image','Video') FOR SHARE`,[ids,reel.merchantProfileId]);
    if(rowCount!==ids.length)throw new Error('INVALID_MEDIA');
    const values=[reel.merchantProfileId,reel.article,reel.destination,reel.productId||null,reel.startsAt,reel.endsAt];
    const {rows:[row]}=reel.id ? await client.query(`UPDATE konektag.merchant_reels SET article=$2,destination=$3,product_id=$4,starts_at=$5,ends_at=$6,updated_at=now() WHERE merchant_profile_id=$1 AND id=$7 RETURNING id`,[...values,reel.id])
    : await client.query(`INSERT INTO konektag.merchant_reels(merchant_profile_id,article,destination,product_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,values);
    if(!row)throw new Error('NOT_FOUND');
    await client.query(`DELETE FROM konektag.merchant_reel_media WHERE reel_id=$1 AND merchant_profile_id=$2`,[row.id,reel.merchantProfileId]);
    for(let i=0;i<ids.length;i++)await client.query(`INSERT INTO konektag.merchant_reel_media(reel_id,merchant_profile_id,media_id,position) VALUES($1,$2,$3,$4)`,[row.id,reel.merchantProfileId,ids[i],i]);
    await client.query('COMMIT');return row;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function listReels(filters: {city?: string;category?: string;merchantProfileId?: string;locale?: string}, actorId?: string) {
  if(actorId) {const client=await pool.connect();try{await requireCoreMerchantActor(client,filters.merchantProfileId!,actorId);}finally{client.release();}}
  const {rows}=await pool.query(`${publicMarketplaceCtes} SELECT r.id,r.merchant_profile_id,r.article,r.destination,r.product_id,r.starts_at,r.ends_at,CASE WHEN $4::boolean THEN mp.slug ELSE n2.snapshot->'merchant'->>'slug' END AS slug,CASE WHEN $4::boolean THEN mp.city ELSE n2.snapshot->'merchant'->>'city' END AS city,COALESCE(oc.activity_code,'Commerce') AS activity_code,
    (SELECT json_agg(json_build_object('id',m.id,'url',m.file_url,'type',m.media_type,'title',m.title) ORDER BY rm.position)
     FROM konektag.merchant_reel_media rm JOIN LATERAL (SELECT id,file_url,media_type,title,deleted_at FROM konektag.merchant_media WHERE $4::boolean AND merchant_profile_id=rm.merchant_profile_id UNION ALL SELECT (item->>'id')::uuid,item->>'fileUrl',item->>'mediaType',item->>'title',NULL::timestamptz FROM public_n3 n3 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n3.snapshot->'media','[]'::jsonb)) item WHERE NOT $4::boolean AND n3.merchant_profile_id=rm.merchant_profile_id AND n3.activity_code=COALESCE(oc.activity_code,'Commerce')) m ON m.id=rm.media_id WHERE rm.reel_id=r.id AND m.deleted_at IS NULL) AS media
    FROM konektag.merchant_reels r JOIN konektag.merchant_profiles mp ON mp.id=r.merchant_profile_id LEFT JOIN public_n2 n2 ON n2.merchant_profile_id=mp.id LEFT JOIN konektag.merchant_products rp ON rp.id=r.product_id AND rp.merchant_profile_id=r.merchant_profile_id LEFT JOIN konektag.offer_categories oc ON oc.id=rp.offer_category_id
    WHERE mp.deleted_at IS NULL AND ($1::text IS NULL OR CASE WHEN $4::boolean THEN mp.city ELSE n2.snapshot->'merchant'->>'city' END=$1) AND ($2::text IS NULL OR ${categorySql('$2')})
    AND ($3::uuid IS NULL OR mp.id=$3) AND ($4::boolean OR (EXISTS (SELECT 1 FROM public_n3 n3 WHERE n3.merchant_profile_id=mp.id AND n3.activity_code=COALESCE(oc.activity_code,'Commerce')) AND mp.status IN ('Published','Referenced') AND r.starts_at<=now() AND r.ends_at>now()
      AND (r.product_id IS NULL OR EXISTS(SELECT 1 FROM public_products p WHERE p.id=r.product_id AND p.merchant_profile_id=r.merchant_profile_id AND ${catalogProductSql}))))
    ORDER BY r.starts_at DESC,r.id`,[filters.city||null,filters.category||null,filters.merchantProfileId||null,!!actorId]);
  return rows.filter(r=>r.media?.length).map(r=>({...r,path:r.destination==='profile'?`/${normalizeLocale(filters.locale)}/marketplace/${marketplaceSlug(r.city||'')}/${encodeURIComponent(r.activity_code||'Commerce')}/${encodeURIComponent(r.slug)}/`:catalogPath(r.merchant_profile_id,r.product_id||undefined,normalizeLocale(filters.locale))}));
}
export async function deleteReel(actorId:string,merchantId:string,id:string) {
  const client=await pool.connect();try {await requireCoreMerchantActor(client,merchantId,actorId);const {rowCount}=await client.query(`DELETE FROM konektag.merchant_reels WHERE id=$1 AND merchant_profile_id=$2`,[id,merchantId]);if(!rowCount)throw new Error('NOT_FOUND');}finally{client.release();}
}
