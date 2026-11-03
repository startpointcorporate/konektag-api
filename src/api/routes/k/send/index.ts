import type { RouteHandler } from '../../../http';
import { kSendService } from '../../../../application/services/k-send-application-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';
import { kPointsBalance } from '../../../../application/services/k-points-service.ts';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

export const POST:RouteHandler=async({request,locals})=>{
 const user=locals.user;if(!user)return json({error:'Unauthorized'},401);
 try{
  const body=await request.json() as {recipientUserId?:string;quantityK?:number};
  const quantityK=Number(body.quantityK);
  if(!body.recipientUserId||!Number.isSafeInteger(quantityK)||quantityK<=0)return json({error:'K_SEND_INVALID_REQUEST'},400);
  const {rows:[recipient]}=await pool.query<{id:string}>(`SELECT id FROM konektag.users WHERE id=$1 AND deleted_at IS NULL`,[body.recipientUserId]);
  if(!recipient)return json({error:'K_SEND_USER_NOT_FOUND'},404);
  const {rows:[party]}=await pool.query<{id:string}>(`SELECT id FROM konektag.parties WHERE keycloak_id=$1 AND is_active=true`,[user.keycloak_id]);
  if(!party)return json({error:'K_SEND_WALLET_NOT_FOUND'},409);
  const balance=await kPointsBalance(party.id);
  if(balance.available<quantityK)return json({error:'K_SEND_INSUFFICIENT',availableK:balance.available},400);
  return json(await kSendService.create({senderId:user.keycloak_id||user.id,recipientUserId:body.recipientUserId,quantityK}),201);
 }catch(error){console.error('[api/k/send]',error);return json({error:error instanceof Error?error.message:'K_SEND_FAILED'},500);}
};
export const GET:RouteHandler=async({url,locals})=>{const user=locals.user;if(!user)return json({error:'Unauthorized'},401);
 const status=url.searchParams.get('status')||undefined,limit=Number(url.searchParams.get('limit')||20),offset=Number(url.searchParams.get('offset')||0);
 const [data,total]=await Promise.all([kSendService.list(user.keycloak_id||user.id,status,limit,offset),kSendService.count(user.keycloak_id||user.id,status)]);
 return json({data,total,offset,limit});};
