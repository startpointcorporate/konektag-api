import { EntitlementDeniedError, entitlementResponse } from '../../../application/services/entitlement-decision-service.ts';
import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import {nativeCatalogRetired} from '../../../domain/native-catalog-retirement.ts';

const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
function err(e:any){
  if(e instanceof EntitlementDeniedError)return entitlementResponse(e.decision);
  const code=e?.message||'SERVER_ERROR';
  if(code==='PRODUCT_NOT_FOUND')return json({error:code},404);
  if(['PRODUCT_NOT_OWNED','MERCHANT_ACCESS_DENIED','INVALID_MEDIA'].includes(code))return json({error:code},403);
  console.error('[merchant/products]',e); return json({error:code},422);
}
export const GET:RouteHandler=async({locals})=>{
  if(!locals.user)return new Response(null,{status:401});
  try{return json({products:await merchantService.listProducts(locals.user.id)});}catch(e){return err(e);}
};
export const POST:RouteHandler=async({locals})=>locals.user?nativeCatalogRetired():json({error:'UNAUTHORIZED'},401);
