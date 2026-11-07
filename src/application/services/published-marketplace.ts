import { z } from 'zod';
import countries from 'i18n-iso-countries';
import { ProjectionUnavailable, toPublicProfile } from '../marketplace-transactions/published-profiles.ts';

export const marketplaceQuery = z.object({
  q: z.string().trim().max(120).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).refine(v => countries.isValid(v)).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  activity: z.string().trim().min(1).max(80).optional(),
  sort: z.enum(['name', 'distance']).default('name'),
  lat: z.coerce.number().finite().min(-90).max(90).optional(),
  lng: z.coerce.number().finite().min(-180).max(180).optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(24),
}).refine(v => v.sort !== 'distance' || (v.lat !== undefined && v.lng !== undefined), { message: 'Distance requires lat and lng' });
export type MarketplaceQuery = z.infer<typeof marketplaceQuery>;
export type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

// No extension dependency: Unicode decomposition covers accented Latin letters;
// ligatures are expanded explicitly. C collation makes pagination reproducible.
const folded = (sql: string) => `replace(replace(regexp_replace(normalize(lower(${sql}), NFD), U&'[\\0300-\\036f]', '', 'g'), 'œ', 'oe'), 'æ', 'ae')`;
const base = `WITH published AS (
 SELECT *, COALESCE(NULLIF(trim(snapshot->>'establishment_name'), ''), slug) AS name,
 snapshot->>'country_code' AS country, snapshot->>'city_id' AS city,
 CASE WHEN snapshot->>'latitude' ~ '^-?[0-9]{1,3}([.][0-9]+)?$'
       AND snapshot->>'longitude' ~ '^-?[0-9]{1,3}([.][0-9]+)?$'
 THEN CASE WHEN abs((snapshot->>'latitude')::double precision)<=90 AND abs((snapshot->>'longitude')::double precision)<=180
 THEN (snapshot->>'latitude')::double precision END END AS lat,
 CASE WHEN snapshot->>'latitude' ~ '^-?[0-9]{1,3}([.][0-9]+)?$'
       AND snapshot->>'longitude' ~ '^-?[0-9]{1,3}([.][0-9]+)?$'
 THEN CASE WHEN abs((snapshot->>'latitude')::double precision)<=90 AND abs((snapshot->>'longitude')::double precision)<=180
 THEN (snapshot->>'longitude')::double precision END END AS lng
 FROM konektag.marketplace_published_establishments WHERE status='Published'
)`;

export function publishedMarketplace(query: Query) {
 return {
  async list(input: MarketplaceQuery) {
   const {q, country, city, activity, sort, lat, lng, page, limit} = input;
   try {
    const {rows} = await query(`${base}, filtered AS (
     SELECT *, ${folded('name')} COLLATE "C" AS name_key,
     CASE WHEN $5::float8 IS NOT NULL AND lat IS NOT NULL THEN
      6371 * 2 * asin(sqrt(least(1::float8, greatest(0::float8,
      power(sin(radians(lat-$5::float8)/2),2)+cos(radians($5::float8))*cos(radians(lat))*power(sin(radians(lng-$6::float8)/2),2))))) END AS distance
     FROM published WHERE ($1::text IS NULL OR strpos(${folded(`concat_ws(' ', name, snapshot->>'description', snapshot->'merchant'->>'description', snapshot->'merchant'->>'seo_description', snapshot->'activities', snapshot->'products', snapshot->'services')`)}, ${folded('$1::text')})>0)
      AND ($2::text IS NULL OR country=$2) AND ($3::text IS NULL OR city=$3)
      AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot->'activities','[]'::jsonb)) a WHERE a->>'activity_code'=$4))
    ), page_rows AS (
      SELECT * FROM filtered ORDER BY ${sort === 'distance' ? 'distance ASC NULLS LAST,' : ''} name_key, slug COLLATE "C" LIMIT $7 OFFSET $8
    ) SELECT (SELECT count(*)::int FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${sort === 'distance' ? 'p.distance ASC NULLS LAST,' : ''} p.name_key, p.slug COLLATE "C") FROM page_rows p),'[]'::jsonb) AS items`,
     [q || null, country ?? null, city ?? null, activity ?? null, sort === 'distance' ? lat : null, sort === 'distance' ? lng : null, limit, (page-1)*limit]);
    return {items: rows[0].items.map((row: any) => {
     const p = toPublicProfile(row);
     return {slug:p.slug, name:p.name, seoDescription:p.seoDescription, city:p.city, countryCode:p.countryCode,
      activities:p.activities.map(a=>({...a,name:a.name ?? a.code})), coordinates:row.lat === null || row.lng === null ? undefined : {lat:row.lat,lng:row.lng}, logo:p.logo,
      ...(sort === 'distance' ? {distanceKm:row.distance ?? null} : {})};
    }), total:rows[0].total, page, limit, sort};
   } catch { throw new ProjectionUnavailable(); }
  },
  async facets() {
   try {
    const {rows} = await query(`${base}, geography AS (
     SELECT country, city, min(snapshot->>'city_name') AS name, count(*)::int AS count FROM published
     WHERE country ~ '^[A-Z]{2}$' GROUP BY country, city
    ), activities AS (
     SELECT a->>'activity_code' AS code, min(COALESCE(NULLIF(a->>'activity_name',''),a->>'activity_code')) AS name,
      count(DISTINCT establishment_id)::int AS count FROM published
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot->'activities','[]'::jsonb)) a
     WHERE NULLIF(a->>'activity_code','') IS NOT NULL GROUP BY a->>'activity_code'
    ) SELECT 'geography' AS kind, to_jsonb(g) AS value FROM geography g
      UNION ALL SELECT 'activity', to_jsonb(a) FROM activities a`, []);
    const countryMap = new Map<string, {code:string;count:number;cities:{id:string;name:string;count:number}[]}>();
    const activities: {code:string;name:string;count:number}[] = [];
    for (const {kind,value:v} of rows) {
     if (kind === 'activity') { activities.push(v); continue; }
     const c: {code:string;count:number;cities:{id:string;name:string;count:number}[]} = countryMap.get(v.country) ?? {code:v.country,count:0,cities:[]};
     c.count += v.count;
     if (v.city) c.cities.push({id:v.city,name:v.name ?? v.city,count:v.count});
     countryMap.set(v.country,c);
    }
    const compare = (a:{name:string}, b:{name:string}) => a.name.localeCompare(b.name,'fr',{sensitivity:'base'});
    return {countries:[...countryMap.values()].sort((a,b)=>a.code.localeCompare(b.code)).map(c=>({...c,cities:c.cities.sort((a,b)=>compare(a,b)||a.id.localeCompare(b.id))})),activities:activities.sort((a,b)=>compare(a,b)||a.code.localeCompare(b.code))};
   } catch { throw new ProjectionUnavailable(); }
  }
 };
}

export async function defaultMarketplace() {
 const {query} = await import('../../infrastructure/database/pool.ts');
 return publishedMarketplace(query);
}
