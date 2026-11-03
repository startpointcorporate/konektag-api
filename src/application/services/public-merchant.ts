import pool from '../../infrastructure/database/pool.ts';
import type {ActivityCode} from '../../domain/MerchantProfile.ts';
import type {MerchantPublicationSnapshot} from '../shared/marketplace/public-merchant-snapshot.ts';
import {publicMarketplaceCtes} from './public-marketplace-sql.ts';
interface PublishedActivity {activity_code:ActivityCode;snapshot:MerchantPublicationSnapshot;version:number;published_at:string}

/** Resolve published and historical slugs. One statement reads a coherent N2/N3 publication state. */
export async function publicEstablishment(slug:string) {
 const {rows:[row]}=await pool.query(`${publicMarketplaceCtes}
 SELECT n2.*,mp.user_id,mp.rating,mp.certification_status,COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'activity_code',n3.activity_code,'snapshot',n3.snapshot,'version',n3.version,'published_at',n3.published_at) ORDER BY n3.activity_code)
 FROM public_n3 n3 WHERE n3.merchant_profile_id=n2.merchant_profile_id),'[]'::jsonb) AS activities
 FROM public_n2 n2 JOIN konektag.merchant_profiles mp ON mp.id=n2.merchant_profile_id
 WHERE n2.snapshot->'merchant'->>'slug'=$1 OR mp.slug=$1 OR EXISTS(
 SELECT 1 FROM konektag.merchant_slug_history h WHERE h.merchant_profile_id=mp.id AND h.old_slug=$1)
 ORDER BY (n2.snapshot->'merchant'->>'slug'=$1) DESC,mp.id LIMIT 1`,[slug]);
 if(!row)return null;
 return {merchant:row.snapshot.merchant,version:row.version,publishedAt:row.published_at,ownerUserId:row.user_id,rating:row.rating,certificationStatus:row.certification_status,activities:row.activities as PublishedActivity[]};
}
