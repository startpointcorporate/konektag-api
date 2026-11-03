import pool from '../infrastructure/database/pool.ts';
import { publicMarketplaceCtes } from './services/public-marketplace-sql.ts';
import type { ActivityCode, MerchantSearchFilters, MerchantSearchResult, MarketplaceSearchItem } from '../domain/MerchantProfile.ts';

const TABLE: Record<ActivityCode,string>={Restaurant:'restaurant_profiles',Hotel:'hotel_profiles',Commerce:'commerce_profiles'};
const PUBLIC_PRODUCT=`p.deleted_at IS NULL AND COALESCE(p.catalog_metadata->>'status','active')='active' AND COALESCE(p.catalog_metadata->>'visibility','public')='public'`;

function normalizeLimit(n?:number){return Math.max(1,Math.min(100,n??20));}
function validateContext(f:MerchantSearchFilters){
  if((f.offerCategoryId||f.offerSubcategoryId)&&!f.activityCode)throw new Error('ACTIVITY_REQUIRED_FOR_CATALOG_FILTER');
  if(f.offerSubcategoryId&&!f.offerCategoryId)throw new Error('CATEGORY_REQUIRED_FOR_SUBCATEGORY');
  const allowed:Record<ActivityCode,Set<string>>={
    Restaurant:new Set(['priceRange','cuisineTypes','hasDelivery','hasTakeAway','hasDineIn','hasReservation','hasMenu','menuType']),
    Hotel:new Set(['priceRange','stars','amenities','hasDelivery','hasTakeAway','hasDineIn','hasOnlineBooking']),
    Commerce:new Set(['priceRange','mainActivity','hasDelivery','hasTakeAway','hasDineIn','hasCatalog']),
  };
  if(!f.activityCode)return;
  for(const k of ['priceRange','cuisineTypes','stars','mainActivity','hasDelivery','hasTakeAway','hasDineIn','hasReservation','hasMenu','menuType','hasOnlineBooking','hasCatalog','amenities'] as const)
    if(f[k]!==undefined&&!allowed[f.activityCode].has(k))throw new Error('FILTER_NOT_ALLOWED_FOR_ACTIVITY');
}
async function validateTaxonomy(f:MerchantSearchFilters){
  if(!f.offerCategoryId&&!f.offerSubcategoryId)return;
  const {rows:[row]}=await pool.query(`SELECT c.id,c.activity_code,s.id AS subcategory_id FROM konektag.offer_categories c LEFT JOIN konektag.offer_subcategories s ON s.category_id=c.id AND s.id=$2::uuid AND s.deleted_at IS NULL AND s.is_active=true WHERE c.id=$1::uuid AND c.deleted_at IS NULL AND c.is_active=true`,[f.offerCategoryId??null,f.offerSubcategoryId??null]);
  if(!row||row.activity_code!==f.activityCode)throw new Error('CATEGORY_ACTIVITY_MISMATCH');
  if(f.offerSubcategoryId&&!row.subcategory_id)throw new Error('SUBCATEGORY_CATEGORY_MISMATCH');
}
function add(c:string[],p:unknown[],sql:string,v:unknown){p.push(v);c.push(sql.replaceAll('?',`$${p.length}`));}
function offerExists(f:MerchantSearchFilters,p:unknown[],text=false){
  const c=[`p.merchant_profile_id=mma.merchant_profile_id`,`p.activity_code=mma.activity_code`,PUBLIC_PRODUCT,`oc.id=p.offer_category_id`,`oc.activity_code=mma.activity_code`,`oc.deleted_at IS NULL`,`oc.is_active=true`];
  if(f.offerCategoryId)add(c,p,'p.offer_category_id=?::uuid',f.offerCategoryId);
  if(f.offerSubcategoryId)add(c,p,'p.offer_subcategory_id=?::uuid',f.offerSubcategoryId);
  if(f.offerType)add(c,p,`COALESCE(p.catalog_metadata->>'type','product')=?`,f.offerType);
  if(text&&f.query){p.push(f.query,`%${f.query.replace(/[!%_]/g, char => '!'+char)}%`);const q=`$${p.length-1}`,like=`$${p.length}`;c.push(`(to_tsvector('french',concat_ws(' ',p.name,p.description,oc.code,oc.name_i18n::text,osc.code,osc.name_i18n::text,p.catalog_metadata->>'shortDescription',p.catalog_metadata->>'detailedDescription',p.catalog_metadata->'tags')) @@ plainto_tsquery('french',${q}) OR p.name ILIKE ${like} ESCAPE '!' OR p.description ILIKE ${like} ESCAPE '!' OR oc.name_i18n::text ILIKE ${like} ESCAPE '!' OR osc.name_i18n::text ILIKE ${like} ESCAPE '!' OR p.catalog_metadata::text ILIKE ${like} ESCAPE '!')`);}
  return `EXISTS(SELECT 1 FROM public_products p JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id LEFT JOIN konektag.offer_subcategories osc ON osc.id=p.offer_subcategory_id AND osc.deleted_at IS NULL AND osc.is_active=true WHERE ${c.join(' AND ')})`;
}
function n3Filters(f:MerchantSearchFilters,p:unknown[]){
  if(!f.activityCode)return '';
  const a=f.activityCode,alias=a==='Restaurant'?'n3r':a==='Hotel'?'n3h':'n3c',c:string[]=[];
  const put=(col:string,v:unknown,cast='')=>add(c,p,`${alias}.${col}=?${cast}`,v);
  if(f.priceRange)put('price_range',f.priceRange);
  if(f.hasDelivery!==undefined)put('has_delivery',f.hasDelivery);
  if(f.hasTakeAway!==undefined)put(a==='Restaurant'?'has_take_away':'has_takeout',f.hasTakeAway);
  if(f.hasDineIn!==undefined)put('has_dine_in',f.hasDineIn);
  if(a==='Restaurant'){if(f.cuisineTypes?.length){p.push(f.cuisineTypes);c.push(`${alias}.cuisine_types ?| $${p.length}`);}if(f.hasReservation!==undefined)put('has_reservation',f.hasReservation);if(f.hasMenu!==undefined)put('has_menu',f.hasMenu);if(f.menuType)put('menu_type',f.menuType);}
  if(a==='Hotel'){if(f.stars!==undefined)put('stars',f.stars);if(f.amenities?.length){p.push(f.amenities);c.push(`${alias}.amenities ?| $${p.length}`);}if(f.hasOnlineBooking!==undefined)put('has_online_booking',f.hasOnlineBooking);}
  if(a==='Commerce'){if(f.mainActivity)put('main_activity',f.mainActivity);if(f.hasCatalog!==undefined)put('has_catalog',f.hasCatalog);}
  return c.length?' AND '+c.join(' AND '):'';
}
function joinN3(a?:ActivityCode){
 if(!a)return '';
 const alias=a==='Restaurant'?'n3r':a==='Hotel'?'n3h':'n3c';
 const common:Record<string,string>={short_description:'shortDescription',long_description:'longDescription',price_range:'priceRange',has_delivery:'hasDelivery',has_dine_in:'hasDineIn'};
 const specific:Record<ActivityCode,Record<string,string>>={
  Restaurant:{cuisine_types:'cuisineTypes',specialties:'specialties',average_meal_price:'averageMealPrice',has_menu:'hasMenu',has_reservation:'hasReservation',has_take_away:'hasTakeAway',menu_type:'menuType'},
  Hotel:{stars:'stars',room_price_min:'roomPriceMin',room_price_max:'roomPriceMax',amenities:'amenities',has_online_booking:'hasOnlineBooking',has_takeout:'hasTakeout'},
  Commerce:{main_activity:'mainActivity',products_services:'productsServices',has_catalog:'hasCatalog',has_takeout:'hasTakeout'},
 };
 const pairs=Object.entries({...common,...specific[a]}).map(([column,key])=>`'${column}',n3snap.snapshot->'activity'->'${key}'`).join(',');
 return ` JOIN LATERAL jsonb_populate_record(NULL::konektag.${TABLE[a]},jsonb_build_object(${pairs})) ${alias} ON true`;
}
function hours(f:MerchantSearchFilters,p:unknown[]){if(!f.openNow)return '';const di='EXTRACT(DOW FROM CURRENT_TIMESTAMP)::int',ti='CURRENT_TIME';return ` AND EXISTS(SELECT 1 FROM public_hours h WHERE h.merchant_profile_id=mma.merchant_profile_id AND h.deleted_at IS NULL AND h.day_of_week=${di} AND h.is_closed=false AND h.activity_code IS NOT DISTINCT FROM COALESCE((SELECT activity_code FROM public_hours hx WHERE hx.merchant_profile_id=mma.merchant_profile_id AND hx.deleted_at IS NULL AND hx.day_of_week=${di} AND hx.activity_code=mma.activity_code LIMIT 1),NULL) AND ((h.open_time<=${ti}::time AND h.close_time>=${ti}::time) OR (h.open_time_2<=${ti}::time AND h.close_time_2>=${ti}::time)))`;}
function map(r:any,scoped:boolean):MarketplaceSearchItem{return {merchantProfileId:r.merchant_profile_id,activityCode:scoped?(r.activity_code??undefined):undefined,availableActivities:r.available_activities??[],businessName:r.business_name,slug:r.slug,logoUrl:r.logo_url??undefined,coverImageUrl:r.cover_image_url??undefined,shortDescription:r.n3_short_description??r.short_description??undefined,longDescription:r.n3_long_description??r.long_description??undefined,address:r.address??undefined,neighborhood:r.neighborhood??undefined,phone:(scoped?r.n3_phone??r.phone:r.phone)??undefined,email:(scoped?r.n3_email??r.email:r.email)??undefined,websiteUrl:r.website_url??undefined,city:r.city??undefined,country:r.country??undefined,latitude:r.latitude==null?undefined:Number(r.latitude),longitude:r.longitude==null?undefined:Number(r.longitude),rating:r.rating==null?undefined:Number(r.rating),certificationStatus:r.certification_status,merchantStatus:r.status,hasPro:!!r.has_pro_subscription,featured:scoped?(r.featured??undefined):undefined,associated:!!r.associated,priceRange:r.price_range??undefined,cuisineTypes:r.cuisine_types??undefined,specialties:r.specialties??undefined,averageMealPrice:r.average_meal_price==null?undefined:Number(r.average_meal_price),hasMenu:r.has_menu??undefined,hasReservation:r.has_reservation??undefined,hasDelivery:r.has_delivery??undefined,hasTakeout:r.has_takeout??r.has_take_away??undefined,hasDineIn:r.has_dine_in??undefined,openNow:r.is_open_now==null?undefined:!!r.is_open_now,distanceKm:r.distance_km==null?undefined:Number(r.distance_km)};}

export async function marketplaceSearch(f:MerchantSearchFilters):Promise<MerchantSearchResult>{
  if(f.page!==undefined&&(!Number.isSafeInteger(f.page)||f.page<1))throw new Error('INVALID_PAGE');
  if(f.limit!==undefined&&(!Number.isSafeInteger(f.limit)||f.limit<1))throw new Error('INVALID_LIMIT');
  f={...f,query:f.query?.trim().slice(0,120)};
  validateContext(f);await validateTaxonomy(f);
  if(f.city&&!f.country&&!f.cityId){const {rows}=await pool.query("SELECT DISTINCT country_code FROM konektag.cities WHERE lower(trim(name))=lower(trim($1)) AND marketplace_review_reason IS NULL",[f.city]);if(rows.length>1)throw new Error('AMBIGUOUS_CITY');}
  const p:unknown[]=[],c=[`mma.status IN ('Published','Referenced')`];
  if(f.activityCode)add(c,p,'mma.activity_code=?',f.activityCode);
  if(f.cityId)add(c,p,'n2.city_id=?::uuid',f.cityId);
  else if(f.city)add(c,p,'mma.city=?',f.city);
  if(f.country)add(c,p,'konektag.city_country_code(mma.country)=konektag.city_country_code(?)',f.country);
  if(f.certified)c.push(`mma.certification_status='VALIDATED'`);
  let relevanceParam:string|undefined;
  if(f.query){p.push(f.query,`%${f.query.replace(/[!%_]/g, char => '!'+char)}%`);const q=`$${p.length-1}`,like=`$${p.length}`;relevanceParam=q;const oe=offerExists(f,p,true);const n3text=` OR n3snap.snapshot->'activity'->>'shortDescription' ILIKE ${like} ESCAPE '!' OR n3snap.snapshot->'activity'->>'longDescription' ILIKE ${like} ESCAPE '!' OR n3snap.activity_code ILIKE ${like} ESCAPE '!'`;c.push(`(to_tsvector('french',concat_ws(' ',mma.business_name,mma.short_description,mma.long_description)) @@ plainto_tsquery('french',${q}) OR mma.business_name ILIKE ${like} ESCAPE '!' OR mma.short_description ILIKE ${like} ESCAPE '!' OR mma.long_description ILIKE ${like} ESCAPE '!' ${n3text} OR ${oe})`);}
  else if(f.offerCategoryId||f.offerSubcategoryId||f.offerType)c.push(offerExists(f,p));
  let geoLatParam:string|undefined,geoLngParam:string|undefined;
  if(f.lat!==undefined&&f.lng!==undefined){p.push(f.lat,f.lng);geoLatParam=`$${p.length-1}`;geoLngParam=`$${p.length}`;c.push(`mma.latitude IS NOT NULL AND mma.longitude IS NOT NULL`);if(f.radiusKm!==undefined){p.push(f.radiusKm);c.push(`konektag.haversine_km(${geoLatParam},${geoLngParam},mma.latitude,mma.longitude)<=$${p.length}`);}if(f.minDistanceKm!==undefined){p.push(f.minDistanceKm);c.push(`konektag.haversine_km(${geoLatParam},${geoLngParam},mma.latitude,mma.longitude)>$${p.length}`);}}
  const extra=n3Filters(f,p)+hours(f,p),where=`WHERE ${c.join(' AND ')}${extra}`,jn=joinN3(f.activityCode);
  const base=`SELECT mma.*,n3snap.snapshot->'activity'->>'phone' AS n3_phone,n3snap.snapshot->'activity'->>'email' AS n3_email,n2.snapshot->'merchant'->>'neighborhood' AS neighborhood,n2.snapshot->'merchant'->>'websiteUrl' AS website_url,
CASE WHEN EXISTS (
 SELECT 1 FROM public_hours hx
 WHERE hx.merchant_profile_id=mma.merchant_profile_id AND hx.deleted_at IS NULL
   AND hx.day_of_week=EXTRACT(DOW FROM CURRENT_TIMESTAMP)::int AND hx.activity_code=mma.activity_code
) THEN EXISTS (
 SELECT 1 FROM public_hours h
 WHERE h.merchant_profile_id=mma.merchant_profile_id AND h.deleted_at IS NULL
   AND h.day_of_week=EXTRACT(DOW FROM CURRENT_TIMESTAMP)::int AND h.activity_code=mma.activity_code
   AND h.is_closed=false
   AND ((h.open_time<=CURRENT_TIME AND h.close_time>=CURRENT_TIME)
     OR (h.open_time_2 IS NOT NULL AND h.open_time_2<=CURRENT_TIME AND h.close_time_2>=CURRENT_TIME))
) ELSE CASE WHEN EXISTS (
 SELECT 1 FROM public_hours hg
 WHERE hg.merchant_profile_id=mma.merchant_profile_id AND hg.deleted_at IS NULL
   AND hg.day_of_week=EXTRACT(DOW FROM CURRENT_TIMESTAMP)::int AND hg.activity_code IS NULL
) THEN EXISTS (
 SELECT 1 FROM public_hours h
 WHERE h.merchant_profile_id=mma.merchant_profile_id AND h.deleted_at IS NULL
   AND h.day_of_week=EXTRACT(DOW FROM CURRENT_TIMESTAMP)::int AND h.activity_code IS NULL
   AND h.is_closed=false
   AND ((h.open_time<=CURRENT_TIME AND h.close_time>=CURRENT_TIME)
     OR (h.open_time_2 IS NOT NULL AND h.open_time_2<=CURRENT_TIME AND h.close_time_2>=CURRENT_TIME))
) ELSE NULL END END AS is_open_now,${f.query&&relevanceParam?`ts_rank(to_tsvector('french',concat_ws(' ',mma.business_name,mma.short_description,mma.long_description)),plainto_tsquery('french',${relevanceParam})) AS relevance,`:''}${f.activityCode?(f.activityCode==='Restaurant'?`n3r.short_description AS n3_short_description,n3r.long_description AS n3_long_description,n3r.price_range,n3r.cuisine_types,n3r.specialties,n3r.average_meal_price,n3r.has_menu,n3r.has_reservation,n3r.has_delivery,n3r.has_take_away,n3r.has_dine_in,`:f.activityCode==='Hotel'?`n3h.short_description AS n3_short_description,n3h.long_description AS n3_long_description,n3h.price_range,n3h.stars,n3h.room_price_min,n3h.room_price_max,n3h.amenities,n3h.has_online_booking,n3h.has_delivery,n3h.has_takeout,n3h.has_dine_in,`:`n3c.short_description AS n3_short_description,n3c.long_description AS n3_long_description,n3c.price_range,n3c.main_activity,n3c.products_services,n3c.has_catalog,n3c.has_delivery,n3c.has_takeout,n3c.has_dine_in,`):''}ARRAY(SELECT DISTINCT x.activity_code FROM public_n3 x WHERE x.merchant_profile_id=mma.merchant_profile_id ORDER BY x.activity_code) available_activities,EXISTS(SELECT 1 FROM konektag.merchant_memberships mm JOIN konektag.merchant_claims mc ON mc.merchant_profile_id=mm.merchant_profile_id AND mc.user_id=mm.user_id AND mc.status='approved' WHERE mm.merchant_profile_id=mma.merchant_profile_id AND mm.role='owner' AND mm.status='active' AND mm.is_primary=true AND mm.removed_at IS NULL) associated,EXISTS(SELECT 1 FROM konektag.merchant_pro_subscriptions ps WHERE ps.merchant_profile_id=mma.merchant_profile_id AND ps.status='ACTIVE' AND ps.subscription_start<=CURRENT_DATE AND (ps.subscription_end IS NULL OR ps.subscription_end>CURRENT_DATE)) has_pro_subscription${geoLatParam&&geoLngParam?`,konektag.haversine_km(${geoLatParam},${geoLngParam},mma.latitude,mma.longitude) distance_km`:''} FROM konektag.marketplace_merchant_activities mma0
 JOIN public_n2 n2 ON n2.merchant_profile_id=mma0.merchant_profile_id
 JOIN public_n3 n3snap ON n3snap.merchant_profile_id=mma0.merchant_profile_id AND n3snap.activity_code=mma0.activity_code
 CROSS JOIN LATERAL jsonb_populate_record(NULL::konektag.marketplace_merchant_activities,jsonb_build_object('business_name',n2.snapshot->'merchant'->'businessName','slug',n2.snapshot->'merchant'->'slug','short_description',n2.snapshot->'merchant'->'shortDescription','long_description',n2.snapshot->'merchant'->'longDescription','city',n2.snapshot->'merchant'->'city','country',n2.snapshot->'merchant'->'country','address',n2.snapshot->'merchant'->'address','phone',n2.snapshot->'merchant'->'phone','email',n2.snapshot->'merchant'->'email','logo_url',n2.snapshot->'merchant'->'logoUrl','cover_image_url',n2.snapshot->'merchant'->'coverImageUrl','latitude',n2.snapshot->'merchant'->'latitude','longitude',n2.snapshot->'merchant'->'longitude','merchant_profile_id',mma0.merchant_profile_id,'activity_code',mma0.activity_code,'status',mma0.status,'featured',mma0.featured,'featured_at',mma0.featured_at,'rating',mma0.rating,'certification_status',mma0.certification_status)) mma${jn} ${where}`;
  const scoped=f.activityCode?base:`SELECT DISTINCT ON (merchant_profile_id) * FROM (${base}) z ORDER BY merchant_profile_id,featured DESC,featured_at DESC NULLS LAST,activity_code`;
  const count=await pool.query(`${publicMarketplaceCtes} SELECT count(*)::int total FROM (${scoped}) s`,p);const total=Number(count.rows[0].total),page=Math.max(1,f.page??1),limit=normalizeLimit(f.limit),offset=(page-1)*limit;
  p.push(limit,offset);const {rows}=await pool.query(`${publicMarketplaceCtes} SELECT * FROM (${scoped}) s ORDER BY featured DESC,associated DESC,(status='Referenced') ASC${f.query?',relevance DESC':''}${f.lat!==undefined&&f.lng!==undefined?',distance_km ASC':''},merchant_profile_id,activity_code LIMIT $${p.length-1} OFFSET $${p.length}`,p);
  const results=rows.map((r:any)=>map(r,!!f.activityCode));
  const needsOfferContext=!!(f.query||f.offerCategoryId||f.offerSubcategoryId||f.offerType);
  if(rows.length){
    if(!f.activityCode&&needsOfferContext){
      const ids=rows.map((r:any)=>r.merchant_profile_id),op:unknown[]=[ids],conds=[`p.merchant_profile_id=ANY($1::uuid[])`,`oc.deleted_at IS NULL`,`oc.is_active=true`,PUBLIC_PRODUCT];
      if(f.offerType){op.push(f.offerType);conds.push(`COALESCE(p.catalog_metadata->>'type','product')=$${op.length}`);}
      if(f.query){op.push(`%${f.query.replace(/[!%_]/g, char => '!'+char)}%`);const like=`$${op.length}`;conds.push(`(p.name ILIKE ${like} ESCAPE '!' OR p.description ILIKE ${like} ESCAPE '!' OR oc.name_i18n::text ILIKE ${like} ESCAPE '!' OR osc.name_i18n::text ILIKE ${like} ESCAPE '!' OR p.catalog_metadata::text ILIKE ${like} ESCAPE '!')`);}
      const {rows:matches}=await pool.query(`${publicMarketplaceCtes} SELECT p.*,oc.activity_code,oc.code category_code,oc.name_i18n category_name_i18n,osc.code subcategory_code,osc.name_i18n subcategory_name_i18n,count(*) OVER(PARTITION BY p.merchant_profile_id) match_count,row_number() OVER(PARTITION BY p.merchant_profile_id ORDER BY p.display_order,p.created_at,p.id) rn FROM public_products p JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id LEFT JOIN konektag.offer_subcategories osc ON osc.id=p.offer_subcategory_id AND osc.deleted_at IS NULL AND osc.is_active=true WHERE ${conds.join(' AND ')}`,op);
      const by=new Map(matches.filter((x:any)=>Number(x.rn)===1).map((x:any)=>[x.merchant_profile_id,x]));
      for(const item of results){const m:any=by.get(item.merchantProfileId);if(m)item.matchContext={source:'offer',activityCode:m.activity_code,offer:{id:m.id,name:m.name,type:m.catalog_metadata?.type??'product',categoryId:m.offer_category_id,categoryCode:m.category_code,categoryNameI18n:m.category_name_i18n,subcategoryId:m.offer_subcategory_id??undefined,subcategoryCode:m.subcategory_code??undefined,subcategoryNameI18n:m.subcategory_name_i18n??undefined,shortDescription:m.catalog_metadata?.shortDescription,price:m.price==null?undefined:Number(m.price),currency:m.currency,imageUrl:m.image_url},additionalMatches:Math.max(0,Number(m.match_count)-1)} as any;}
    }
    if(f.activityCode){
    if(f.query){
      const qLower=f.query.toLocaleLowerCase();
      for(let i=0;i<results.length;i++){const r:any=rows[i];const n3Text=`${r.n3_short_description??''} ${r.n3_long_description??''}`.toLocaleLowerCase();results[i].matchContext={source:n3Text.includes(qLower)?'n3':'merchant'};}
    }
    if(needsOfferContext){
      const ids=rows.map((r:any)=>r.merchant_profile_id),op:unknown[]=[ids,f.activityCode],conds=[`p.merchant_profile_id=ANY($1::uuid[])`,`oc.activity_code=$2`,`oc.deleted_at IS NULL`,`oc.is_active=true`,PUBLIC_PRODUCT];
      if(f.offerCategoryId){op.push(f.offerCategoryId);conds.push(`p.offer_category_id=$${op.length}::uuid`);}
      if(f.offerSubcategoryId){op.push(f.offerSubcategoryId);conds.push(`p.offer_subcategory_id=$${op.length}::uuid`);}
      if(f.offerType){op.push(f.offerType);conds.push(`COALESCE(p.catalog_metadata->>'type','product')=$${op.length}`);}
      if(f.query){op.push(`%${f.query.replace(/[!%_]/g, char => '!'+char)}%`);const like=`$${op.length}`;conds.push(`(p.name ILIKE ${like} ESCAPE '!' OR p.description ILIKE ${like} ESCAPE '!' OR oc.name_i18n::text ILIKE ${like} ESCAPE '!' OR osc.name_i18n::text ILIKE ${like} ESCAPE '!' OR p.catalog_metadata::text ILIKE ${like} ESCAPE '!')`);}
      const {rows:matches}=await pool.query(`${publicMarketplaceCtes} SELECT p.*,oc.code category_code,oc.name_i18n category_name_i18n,osc.code subcategory_code,osc.name_i18n subcategory_name_i18n,count(*) OVER(PARTITION BY p.merchant_profile_id) match_count,row_number() OVER(PARTITION BY p.merchant_profile_id ORDER BY p.display_order,p.created_at,p.id) rn FROM public_products p JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id LEFT JOIN konektag.offer_subcategories osc ON osc.id=p.offer_subcategory_id AND osc.deleted_at IS NULL AND osc.is_active=true WHERE ${conds.join(' AND ')}`,op);
      const by=new Map(matches.filter((x:any)=>Number(x.rn)===1).map((x:any)=>[x.merchant_profile_id,x]));
      for(const item of results){const m:any=by.get(item.merchantProfileId);if(m)item.matchContext={source:'offer',offer:{id:m.id,name:m.name,type:m.catalog_metadata?.type??'product',categoryId:m.offer_category_id,categoryCode:m.category_code,categoryNameI18n:m.category_name_i18n,subcategoryId:m.offer_subcategory_id??undefined,subcategoryCode:m.subcategory_code??undefined,subcategoryNameI18n:m.subcategory_name_i18n??undefined,shortDescription:m.catalog_metadata?.shortDescription,price:m.price==null?undefined:Number(m.price),currency:m.currency,imageUrl:m.image_url},additionalMatches:Math.max(0,Number(m.match_count)-1)};}
    }
    }
  }
  return {results,total,page,limit};
}
