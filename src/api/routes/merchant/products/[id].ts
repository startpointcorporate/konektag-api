import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { merchantService } from '../../../../application/merchant-service.ts';
import {nativeCatalogRetired} from '../../../../domain/native-catalog-retirement.ts';
import { EntitlementDeniedError, entitlementResponse } from '../../../../application/services/entitlement-decision-service.ts';

const Id=z.string().uuid();
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
function err(e:any){
  if(e instanceof EntitlementDeniedError)return entitlementResponse(e.decision);
  const code=e?.message||'SERVER_ERROR';
  if(code==='PRODUCT_NOT_FOUND')return json({error:code},404);
  if(['PRODUCT_NOT_OWNED','MERCHANT_ACCESS_DENIED','INVALID_MEDIA'].includes(code))return json({error:code},403);
  console.error('[merchant/products/:id]',e); return json({error:code},422);
}
const pid=(params:Record<string,string|undefined>)=>{const x=Id.safeParse(params.id);return x.success?x.data:null;};
export const GET:RouteHandler=async({locals,params})=>{
  if(!locals.user)return new Response(null,{status:401}); const id=pid(params); if(!id)return json({error:'INVALID_PRODUCT_ID'},422);
  try{return json({product:await merchantService.getProduct(locals.user.id,id)});}catch(e){return err(e);}
};
export const PATCH:RouteHandler=async({locals})=>locals.user?nativeCatalogRetired():json({error:'UNAUTHORIZED'},401);
export const DELETE:RouteHandler=PATCH;
