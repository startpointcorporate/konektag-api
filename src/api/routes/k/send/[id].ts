import type { RouteHandler } from '../../../http';
import { kSendService } from '../../../../application/services/k-send-application-service.ts';
import { kSendOtpService } from '../../../../application/services/k-send-otp-service.ts';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

export const GET:RouteHandler=async({params,locals})=>{const user=locals.user;if(!user)return json({error:'Unauthorized'},401);try{
 const send=await kSendService.get(params.id!);if(send.senderId!==user.keycloak_id&&send.senderId!==user.id)return json({error:'Forbidden'},403);return json(send);
}catch(e){return json({error:e instanceof Error?e.message:'K_SEND_FAILED'},500);}};

export const POST:RouteHandler=async({params,request,locals})=>{const user=locals.user;if(!user)return json({error:'Unauthorized'},401);try{
 const id=params.id!,send=await kSendService.get(id);
 if(send.senderId!==user.keycloak_id&&send.senderId!==user.id)return json({error:'Forbidden'},403);
 if(send.status==='Funded')return json(send);
 const body=await request.json() as {authorizationId?:string;otp?:string};
 if(!body.authorizationId||!body.otp){
  const issued=await kSendOtpService.issue({userId:user.id,sendId:id,email:user.email||'',locale:user.locale,displayName:user.username||user.email||'',
   quantityK:send.quantityK,recipientName:send.recipientName||'Utilisateur Konektag'});
  return json({requiresOtp:true,...issued},202);
 }
 await kSendOtpService.verify({userId:user.id,sendId:id,authorizationId:body.authorizationId,otp:body.otp});
 return json(await kSendService.execute(id,`k-send-otp:${id}`));
}catch(e){console.error('[api/k/send/:id]',e);const code=e instanceof Error?e.message:'K_SEND_FAILED';
 if(code.startsWith('USER_KYC_REQUIRED:'))return json({error:'USER_KYC_REQUIRED'},403);
 if(['K_SEND_STATE_CONFLICT','K_SEND_IDEMPOTENCY_CONFLICT','K_SEND_INSUFFICIENT'].includes(code))return json({error:code},409);
 return json({error:code},500);}};

export const DELETE:RouteHandler=async({params,locals})=>{const user=locals.user;if(!user)return json({error:'Unauthorized'},401);
 const send=await kSendService.get(params.id!);if(send.senderId!==user.keycloak_id&&send.senderId!==user.id)return json({error:'Forbidden'},403);
 return json(await kSendService.cancel(params.id!));};
