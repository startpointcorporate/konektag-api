import type { RouteHandler } from '../../http';
import { z } from 'zod';
import pool from '../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../application/merchant-service.ts';

const Query=z.object({activity:z.enum(['Restaurant','Hotel','Commerce'])});
export const GET:RouteHandler=async({locals,url})=>{
 if(!locals.user)return new Response(null,{status:401});
 const parsed=Query.safeParse({activity:url.searchParams.get('activity')});if(!parsed.success)return new Response(JSON.stringify({error:'INVALID_ACTIVITY'}),{status:422});
 try{
  const profile=await merchantService.getProfile(locals.user.id), code=parsed.data.activity;
  const {rows:[live]}=await pool.query(`SELECT version,snapshot,published_at FROM konektag.merchant_publication_snapshots WHERE merchant_profile_id=$1 AND activity_code=$2 ORDER BY version DESC LIMIT 1`,[profile.id,code]);
  if(!live)return new Response(JSON.stringify({published:false,hasUnpublishedChanges:true,version:null}),{headers:{'Content-Type':'application/json'}});
  const rawActivity=code==='Restaurant'?profile.restaurantProfile:code==='Hotel'?profile.hotelProfile:profile.commerceProfile;
  const activity={...(rawActivity as any),shortDescription:(rawActivity as any)?.shortDescription??profile.shortDescription,longDescription:(rawActivity as any)?.longDescription??profile.longDescription,phone:(rawActivity as any)?.phone??profile.phone,email:(rawActivity as any)?.email??profile.email};
  const allHours=profile.openingHours??[],specific=allHours.filter(h=>h.activityCode===code),byDay=new Map(specific.map(h=>[h.dayOfWeek,h]));
  const resolvedHours=specific.length?allHours.filter(h=>h.activityCode==null).map(h=>byDay.get(h.dayOfWeek)??({...h,activityCode:code})).concat(specific.filter(h=>!allHours.some(g=>g.activityCode==null&&g.dayOfWeek===h.dayOfWeek))):allHours.filter(h=>h.activityCode==null).map(h=>({...h,activityCode:code}));
  const current={merchant:{businessName:profile.businessName,slug:profile.slug,logoUrl:profile.logoUrl,coverImageUrl:profile.coverImageUrl,shortDescription:profile.shortDescription,longDescription:profile.longDescription,address:profile.address,city:profile.city,country:profile.country,neighborhood:profile.neighborhood,phone:profile.phone,email:profile.email,websiteUrl:profile.websiteUrl,latitude:profile.latitude,longitude:profile.longitude,certificationStatus:profile.certificationStatus},activity,media:profile.media??[],externalLinks:profile.externalLinks??[],openingHours:resolvedHours,products:profile.products??[]};
  const snap=live.snapshot||{}; const comparable={merchant:snap.merchant,activity:snap.activity,media:snap.media??[],externalLinks:snap.externalLinks??[],openingHours:snap.openingHours??[],products:snap.products??[]};
  return new Response(JSON.stringify({published:true,version:live.version,publishedAt:live.published_at,hasUnpublishedChanges:JSON.stringify(current)!==JSON.stringify(comparable)}),{headers:{'Content-Type':'application/json'}});
 }catch{return new Response(JSON.stringify({error:'SERVER_ERROR'}),{status:500,headers:{'Content-Type':'application/json'}});}
};