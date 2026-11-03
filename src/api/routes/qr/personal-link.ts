import type { RouteHandler } from '../../http';
import crypto from 'node:crypto';
import pool from '../../../infrastructure/database/pool.ts';
import { resolveUserOperationCurrency } from '../../../application/services/operation-currency-service.ts';

export const POST: RouteHandler=async({locals})=>{
 try {
 const auth=(locals as any).user;
 if(!auth?.keycloak_id) return Response.json({error:'UNAUTHORIZED'},{status:401});
 const {rows:[user]}=await pool.query(
  `SELECT id,username,keycloak_id FROM konektag.users WHERE keycloak_id=$1 AND deleted_at IS NULL`,[auth.keycloak_id]);
 if(!user) return Response.json({error:'USER_NOT_FOUND'},{status:404});
 const context=await resolveUserOperationCurrency(pool,user.id);
 const token=crypto.randomBytes(32).toString('base64url');
 const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
 const publicId=crypto.randomUUID();
 await pool.query(
  `INSERT INTO konektag.checkout_intents
   (token_hash,owner_user_id,amount,currency,expiration,status,usage_unique,source_type,public_id,reference,qr_type)
   VALUES($1,$2,0,$3,now()+interval '30 days','ISSUED',false,'personal_link',$4,'','Static')`,
  [tokenHash,user.id,context.currency,publicId]);
 return Response.json({token,publicId,ownerUserId:user.id,displayName:user.username||'Utilisateur',currency:context.currency});
 } catch(error:any) {
   console.error('[personal-link] create failed', error);
   return Response.json({error:error?.code||error?.message||'PERSONAL_LINK_CREATE_FAILED'},{status:500});
 }
};

export const GET: RouteHandler=async({request,locals})=>{
 const auth=(locals as any).user;
 if(!auth?.keycloak_id) return Response.json({error:'UNAUTHORIZED'},{status:401});
 const url=new URL(request.url), token=url.searchParams.get('token')||'', publicId=url.searchParams.get('publicId')||'';
 if(!token||!publicId) return Response.json({error:'LINK_REQUIRED'},{status:400});
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const {rows:[row]}=await pool.query(
  `SELECT ci.owner_user_id,ci.currency,u.username
   FROM konektag.checkout_intents ci JOIN konektag.users u ON u.id=ci.owner_user_id
   WHERE ci.public_id=$1 AND ci.token_hash=$2 AND ci.source_type='personal_link'
     AND ci.status='ISSUED' AND ci.expiration>now()`,[publicId,hash]);
 if(!row) return Response.json({error:'LINK_INVALID_OR_EXPIRED'},{status:404});
 return Response.json({ownerUserId:row.owner_user_id,currency:row.currency,displayName:row.username});
};
