import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { merchantService } from '../../../application/merchant-service.ts';
import { notifyIndexNow } from '../../../application/shared/indexnow.ts';
import { getSiteUrl } from '../../../application/shared/seo.ts';
import { marketplaceSlug } from '../../../application/shared/marketplace/slug.ts';
export const POST:RouteHandler=async({locals,request})=>{
 if(!locals.user)return new Response(null,{status:401});
 let body:any={};try{body=await request.json();}catch{}
 const parsed=z.object({merchantProfileId:z.string().uuid().optional()}).safeParse(body);
 if(!parsed.success)return new Response(JSON.stringify({error:'INVALID_REQUEST'}),{status:422});
 try{const profile=await merchantService.publishEstablishment(locals.user.id,parsed.data.merchantProfileId);const urls=['fr','en','ar','pt','es','sw','ha','yo','zh','hi'].map(locale=>`${getSiteUrl()}/${locale}/marketplace/${marketplaceSlug(profile.city||'')}/${profile.slug}/`);notifyIndexNow(urls).catch(e=>console.error('[IndexNow] publish establishment',e));return new Response(JSON.stringify(profile),{headers:{'Content-Type':'application/json'}});}
 catch(e:any){return new Response(JSON.stringify({error:e?.code||'SERVER_ERROR',message:e?.message}),{status:e?.code==='MERCHANT_NOT_OWNER'?403:e?.code==='MERCHANT_LOCATION_REQUIRED'?422:500,headers:{'Content-Type':'application/json'}});}
};