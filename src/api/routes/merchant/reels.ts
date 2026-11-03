import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { saveReel, listReels, deleteReel } from '../../../application/public-catalog-service.ts';
import { operationsJson, operationsError } from '../../../application/merchant-operations-http.ts';
const identity=z.object({merchantProfileId:z.string().uuid(),id:z.string().uuid()});
export const GET:RouteHandler=async({locals,url})=>{
 if(!locals.user)return operationsJson({error:'UNAUTHORIZED'},401);
 const merchantId=url.searchParams.get('merchantProfileId');
 if(!z.string().uuid().safeParse(merchantId).success)return operationsJson({error:'INVALID_MERCHANT'},422);
 try{return operationsJson(await listReels({merchantProfileId:merchantId!,locale:url.searchParams.get('locale')||undefined},locals.user.id));}catch(e){return operationsError(e);}
};
export const POST:RouteHandler=async({locals,request})=>{
 if(!locals.user)return operationsJson({error:'UNAUTHORIZED'},401);
 try{return operationsJson(await saveReel(locals.user.id,await request.json()),201);}catch(e){return e instanceof z.ZodError?operationsJson({error:'INVALID_REEL',details:e.flatten()},422):operationsError(e);}
};
export const DELETE:RouteHandler=async({locals,request})=>{
 if(!locals.user)return operationsJson({error:'UNAUTHORIZED'},401);
 const body=identity.safeParse(await request.json().catch(()=>null));if(!body.success)return operationsJson({error:'INVALID_REEL'},422);
 try{await deleteReel(locals.user.id,body.data.merchantProfileId,body.data.id);return operationsJson({deleted:true});}catch(e){return operationsError(e);}
};
