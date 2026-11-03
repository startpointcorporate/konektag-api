import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { marketplaceSearch } from '../../../application/marketplace-search-service.ts';
import { ActivityCodeSchema } from '../../../application/merchant-activity-profile.ts';

const Bool=z.enum(['true','false']).transform(v=>v==='true');
const uuid=z.string().uuid();
export const GET:RouteHandler=async({request})=>{
  const u=new URL(request.url),one=(k:string)=>u.searchParams.get(k)??undefined;
  const raw:any={
    cityId:one('city_id'),query:one('q'),activityCode:one('activity'),city:one('city'),country:one('country'),
    offerType:one('offer_type'),offerCategoryId:one('category'),offerSubcategoryId:one('subcategory'),
    priceRange:one('price'),mainActivity:one('main_activity'),menuType:one('menu_type'),
    cuisineTypes:u.searchParams.getAll('cuisine').length?u.searchParams.getAll('cuisine'):undefined,
    amenities:u.searchParams.getAll('amenity').length?u.searchParams.getAll('amenity'):undefined,
  };
  for(const [q,k] of [['delivery','hasDelivery'],['takeaway','hasTakeAway'],['dinein','hasDineIn'],['reservation','hasReservation'],['hasmenu','hasMenu'],['onlinebooking','hasOnlineBooking'],['catalog','hasCatalog'],['open_now','openNow'],['certified','certified']] as const)if(u.searchParams.has(q)){const x=Bool.safeParse(one(q));if(!x.success)return new Response(JSON.stringify({error:'INVALID_BOOLEAN',field:q}),{status:422});raw[k]=x.data;}
  for(const [q,k] of [['stars','stars'],['lat','lat'],['lng','lng'],['radius','radiusKm'],['min_distance','minDistanceKm'],['page','page'],['limit','limit']] as const)if(one(q)!==undefined){const n=Number(one(q));if(!Number.isFinite(n))return new Response(JSON.stringify({error:'INVALID_NUMBER',field:q}),{status:422});raw[k]=n;}
  if(raw.cityId&&!uuid.safeParse(raw.cityId).success)return Response.json({error:'INVALID_CITY_ID'},{status:422});
  if(raw.activityCode&&!ActivityCodeSchema.safeParse(raw.activityCode).success)return new Response(JSON.stringify({error:'INVALID_ACTIVITY_CODE'}),{status:422});
  if(raw.offerCategoryId&&!uuid.safeParse(raw.offerCategoryId).success)return new Response(JSON.stringify({error:'INVALID_CATEGORY_ID'}),{status:422});
  if(raw.offerSubcategoryId&&!uuid.safeParse(raw.offerSubcategoryId).success)return new Response(JSON.stringify({error:'INVALID_SUBCATEGORY_ID'}),{status:422});
  try{return new Response(JSON.stringify(await marketplaceSearch(raw)),{status:200,headers:{'Content-Type':'application/json'}});}
  catch(e:any){const code=e?.message||'SERVER_ERROR';if(['INVALID_PAGE','INVALID_LIMIT','AMBIGUOUS_CITY','ACTIVITY_REQUIRED_FOR_CATALOG_FILTER','CATEGORY_REQUIRED_FOR_SUBCATEGORY','FILTER_NOT_ALLOWED_FOR_ACTIVITY','CATEGORY_ACTIVITY_MISMATCH','SUBCATEGORY_CATEGORY_MISMATCH'].includes(code))return new Response(JSON.stringify({error:code}),{status:422,headers:{'Content-Type':'application/json'}});console.error('[merchant/search]',e);return new Response(JSON.stringify({error:'SERVER_ERROR'}),{status:500});}
};
