import { randomUUID } from 'node:crypto';
import { redisAdapter } from '../../infrastructure/adapters/redis-adapter.ts';
import { emailService } from './resend-service.ts';

function key(userId:string,sendId:string,authorizationId:string){return `k-send:${userId}:${sendId}:${authorizationId}`;}

export const kSendOtpService={
 async issue(input:{userId:string;sendId:string;email:string;locale?:string;displayName?:string;quantityK:number;recipientName:string}){
  if(!input.email)throw new Error('K_SEND_EMAIL_REQUIRED');
  const allowed=await redisAdapter.checkRateLimit(`k-send-otp:issue:${input.userId}`,5,15*60);
  if(!allowed)throw new Error('K_SEND_OTP_RATE_LIMITED');
  const authorizationId=randomUUID();
  const code=await redisAdapter.setOtp(key(input.userId,input.sendId,authorizationId));
  const sent=await emailService.sendTemplate('otpCode',input.locale==='en'?'en':'fr',input.email,{
   firstName:input.displayName||'',code,currentYear:String(new Date().getFullYear()),
  }).catch(()=>false);
  if(!sent)throw new Error('K_SEND_OTP_DELIVERY_FAILED');
  return {authorization:{id:authorizationId,operationType:'k_send',operationId:`k_send:${input.sendId}`,amount:input.quantityK,unit:'K',recipientName:input.recipientName},emailSent:true};
 },
 async verify(input:{userId:string;sendId:string;authorizationId:string;otp:string}){
  if(!input.authorizationId)throw new Error('K_SEND_OTP_MISMATCH');
  const allowed=await redisAdapter.checkRateLimit(`k-send-otp:verify:${input.userId}:${input.sendId}`,10,5*60);
  if(!allowed)throw new Error('K_SEND_OTP_RATE_LIMITED');
  const ok=await redisAdapter.verifyOtp(key(input.userId,input.sendId,input.authorizationId),input.otp.trim());
  if(!ok)throw new Error('K_SEND_OTP_INVALID');
  return true;
 }
};
