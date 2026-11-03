import { beforeEach, describe, expect, it, vi } from 'vitest';

const query=vi.hoisted(()=>vi.fn());
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query}}));
import { marketplaceSearch } from '../../src/application/marketplace-search-service.ts';

const category='123e4567-e89b-12d3-a456-426614174001';
const subcategory='123e4567-e89b-12d3-a456-426614174002';
const merchant='123e4567-e89b-12d3-a456-426614174003';
function sql(){return query.mock.calls.map(c=>String(c[0])).join('\n');}
function standard(){
  query.mockImplementation(async(q:string)=>{
    if(q.includes('FROM konektag.offer_categories c LEFT JOIN'))return {rows:[{id:category,activity_code:'Restaurant',subcategory_id:subcategory}]};
    if(q.includes('count(*)::int total'))return {rows:[{total:1}]};
    if(q.includes('SELECT * FROM ('))return {rows:[{merchant_profile_id:merchant,activity_code:'Restaurant',available_activities:['Restaurant'],business_name:'Chez A',slug:'chez-a',city:'Paris',country:'FR',certification_status:'NON_CERTIFIED',status:'Published',featured:false,associated:true}]};
    if(q.includes('row_number() OVER'))return {rows:[]};
    return {rows:[]};
  });
}
beforeEach(()=>{query.mockReset();standard();});

describe('P3-A2 marketplace search invariants',()=>{
  it('1 mono-N3 uses the P1 read model',async()=>{await marketplaceSearch({activityCode:'Restaurant'});expect(sql()).toContain('marketplace_merchant_activities');});
  it('2 multi-N3 scopes by activity',async()=>{await marketplaceSearch({activityCode:'Hotel'});expect(sql()).toContain('mma.activity_code=');});
  it('3 geographic dataset deduplicates establishments',async()=>{await marketplaceSearch({country:'FR',city:'Paris'});expect(sql()).toContain('DISTINCT ON');});
  it('4 deduplicates by establishment identity after applying country and city filters', async () => {
    await marketplaceSearch({ country: 'FR', city: 'Paris' });
    // Location filters use the published N2 projection and normalized country codes.
    // Its primary key identifies an establishment independently of its name/location.
    expect(query.mock.calls).toHaveLength(2);
    for (const [statement, params] of query.mock.calls) {
      expect(statement).toContain('SELECT DISTINCT ON (merchant_profile_id)');
      expect(statement).toContain('mma.city=$1 AND konektag.city_country_code(mma.country)=konektag.city_country_code($2)');
      expect(params.slice(0, 2)).toEqual(['Paris', 'FR']);
    }
    expect(query.mock.calls[1][1]).toEqual(['Paris', 'FR', 20, 0]);
  });
  it('5 geographic search does not require GPS',async()=>{await expect(marketplaceSearch({country:'FR',city:'Paris'})).resolves.toBeTruthy();});
  it('6 Restaurant joins only restaurant profile',async()=>{await marketplaceSearch({activityCode:'Restaurant'});expect(sql()).toContain('NULL::konektag.restaurant_profiles');expect(sql()).not.toContain('NULL::konektag.hotel_profiles');});
  it('7 Hotel joins only hotel profile',async()=>{await marketplaceSearch({activityCode:'Hotel'});expect(sql()).toContain('NULL::konektag.hotel_profiles');expect(sql()).not.toContain('NULL::konektag.restaurant_profiles');});
  it('8 boost authority is N3 view featured',async()=>{await marketplaceSearch({activityCode:'Restaurant'});expect(sql()).toContain('featured DESC');});
  it('9 association ranks after boost',async()=>{await marketplaceSearch({activityCode:'Restaurant'});expect(sql()).toContain('featured DESC,associated DESC');});
  it('10 category must belong to activity',async()=>{query.mockImplementation(async(q:string)=>q.includes('offer_categories c LEFT JOIN')?{rows:[{id:category,activity_code:'Hotel'}]}:{rows:[]});await expect(marketplaceSearch({activityCode:'Restaurant',offerCategoryId:category})).rejects.toThrow('CATEGORY_ACTIVITY_MISMATCH');});
  it('11 subcategory must belong to category',async()=>{query.mockImplementation(async(q:string)=>q.includes('offer_categories c LEFT JOIN')?{rows:[{id:category,activity_code:'Restaurant',subcategory_id:null}]}:{rows:[]});await expect(marketplaceSearch({activityCode:'Restaurant',offerCategoryId:category,offerSubcategoryId:subcategory})).rejects.toThrow('SUBCATEGORY_CATEGORY_MISMATCH');});
  it('12 offer text participates in Restaurant search',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain('public_products p JOIN konektag.offer_categories');});
  it('13 offers are scoped by category activity',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain('oc.activity_code=mma.activity_code');});
  it('14 offer metadata participates in Hotel text search',async()=>{await marketplaceSearch({activityCode:'Hotel',query:'chambre climatisée'});expect(sql()).toContain('p.catalog_metadata::text');});
  it('15 non-public offers are excluded',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain("visibility','public");expect(sql()).toContain("status','active");});
  it('16 PRO-06 enriched text and tags remain searchable',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'vegan'});expect(sql()).toContain('detailedDescription');expect(sql()).toContain("'tags'");});
  it('17 matchContext is scoped to selected activity',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain('oc.activity_code=$2');});
  it('18 contextual offers count additional matches',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain('count(*) OVER(PARTITION BY p.merchant_profile_id)');});
  it('19 Restaurant filter maps only to Restaurant table',async()=>{await marketplaceSearch({activityCode:'Restaurant',hasReservation:true});expect(sql()).toContain('n3r.has_reservation');});
  it('20 N3 and Offer filters combine in one dataset',async()=>{await marketplaceSearch({activityCode:'Restaurant',hasReservation:true,offerCategoryId:category});expect(sql()).toContain('n3r.has_reservation');expect(sql()).toContain('p.offer_category_id');});
  it('21 openNow uses activity-aware opening hours',async()=>{await marketplaceSearch({activityCode:'Restaurant',openNow:true});expect(sql()).toContain('hx.activity_code=mma.activity_code');});
  it('22 openNow contains generic-hours fallback',async()=>{await marketplaceSearch({activityCode:'Restaurant',openNow:true});expect(sql()).toContain('IS NOT DISTINCT FROM');});
  it('23 geo radius uses haversine',async()=>{await marketplaceSearch({activityCode:'Restaurant',lat:48.8,lng:2.3,radiusKm:5});expect(sql()).toContain('haversine_km');});
  it('24 pagination uses limit and offset',async()=>{const r=await marketplaceSearch({activityCode:'Restaurant',page:2,limit:10});expect(r.page).toBe(2);expect(r.limit).toBe(10);expect(sql()).toContain('LIMIT');});
  it('25 total counts the exact scoped dataset',async()=>{await marketplaceSearch({activityCode:'Restaurant'});expect(sql()).toContain('SELECT count(*)::int total FROM (');});
  it('26 certification filter is explicit',async()=>{await marketplaceSearch({activityCode:'Restaurant',certified:true});expect(sql()).toContain("certification_status='VALIDATED'");});
  it('27 ranking is deterministic and includes relevance',async()=>{await marketplaceSearch({activityCode:'Restaurant',query:'pizza'});expect(sql()).toContain('relevance DESC');expect(sql()).toContain('merchant_profile_id,activity_code');});
  it('28 a selected activity never joins all three N3 tables',async()=>{await marketplaceSearch({activityCode:'Commerce'});const s=sql();expect(s).toContain('NULL::konektag.commerce_profiles');expect(s).not.toContain('NULL::konektag.restaurant_profiles');expect(s).not.toContain('NULL::konektag.hotel_profiles');});
});
