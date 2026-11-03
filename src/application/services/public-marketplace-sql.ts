/** Public readers share immutable snapshots; mutable rows only supply visibility gates. */
export const publicMarketplaceCtes = `WITH
latest_n2 AS (
 SELECT DISTINCT ON (merchant_profile_id) merchant_profile_id,snapshot,version,published_at
 FROM konektag.merchant_n2_publication_snapshots ORDER BY merchant_profile_id,version DESC
),
public_n2 AS (
 SELECT s.*,city.id AS city_id FROM latest_n2 s
 JOIN konektag.merchant_profiles mp ON mp.id=s.merchant_profile_id
 LEFT JOIN LATERAL (
   SELECT COALESCE(c.marketplace_canonical_id,c.id) AS id
   FROM konektag.cities c JOIN konektag.cities canonical ON canonical.id=COALESCE(c.marketplace_canonical_id,c.id)
   WHERE c.marketplace_review_reason IS NULL AND canonical.marketplace_review_reason IS NULL
     AND c.country_code=canonical.country_code
     AND c.country_code=konektag.city_country_code(s.snapshot->'merchant'->>'country')
     AND (CASE WHEN NULLIF(s.snapshot->'merchant'->>'cityId','') IS NOT NULL
          THEN c.id::text=s.snapshot->'merchant'->>'cityId'
          ELSE lower(trim(c.name))=lower(trim(s.snapshot->'merchant'->>'city')) END)
   ORDER BY c.id LIMIT 1
 ) city ON true
 WHERE mp.deleted_at IS NULL AND mp.status<>'Suspended'
   AND NULLIF(trim(s.snapshot->'merchant'->>'slug'),'') IS NOT NULL
   AND NULLIF(trim(s.snapshot->'merchant'->>'businessName'),'') IS NOT NULL
),
latest_n3 AS (
 SELECT DISTINCT ON (merchant_profile_id,activity_code) merchant_profile_id,activity_code,snapshot,version,published_at
 FROM konektag.merchant_publication_snapshots ORDER BY merchant_profile_id,activity_code,version DESC
),
public_n3 AS (
 SELECT s.* FROM latest_n3 s JOIN public_n2 n2 USING(merchant_profile_id)
 JOIN konektag.marketplace_merchant_activities mma USING(merchant_profile_id,activity_code)
 WHERE mma.status IN ('Published','Referenced') AND jsonb_typeof(s.snapshot->'activity')='object'
),
public_products AS (
 SELECT p.*,s.activity_code FROM public_n3 s
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.snapshot->'products')='array' THEN s.snapshot->'products' ELSE '[]'::jsonb END) item
 CROSS JOIN LATERAL jsonb_populate_record(NULL::konektag.merchant_products,
   (SELECT jsonb_object_agg(lower(regexp_replace(key,'([A-Z])','_\\1','g')),value) FROM jsonb_each(item))
   ||jsonb_build_object('merchant_profile_id',s.merchant_profile_id)) p
 JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.activity_code=s.activity_code
),
public_hours AS (
 SELECT h.* FROM public_n3 s
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.snapshot->'openingHours')='array' THEN s.snapshot->'openingHours' ELSE '[]'::jsonb END) item
 CROSS JOIN LATERAL jsonb_populate_record(NULL::konektag.merchant_opening_hours,
   (SELECT jsonb_object_agg(lower(regexp_replace(key,'([A-Z])','_\\1','g')),value) FROM jsonb_each(item))
   ||jsonb_build_object('merchant_profile_id',s.merchant_profile_id,'activity_code',s.activity_code)) h
)`;
