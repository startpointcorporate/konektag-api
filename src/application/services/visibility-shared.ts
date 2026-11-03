import type { RequestContext } from '../../api/http';
import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import { marketplaceMerchantPath } from '../shared/marketplace/slug.ts';
export class VisibilityError extends Error{constructor(public code:string,public status=422){super(code);}}
export const visibilityId=(v:unknown)=>{if(typeof v!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v))throw new VisibilityError('INVALID_ID',400);return v;};
export function visibilityText(v:unknown,max:number,required=true){if(v==null&&!required)return '';if(typeof v!=='string'||v.trim().length>max||(required&&!v.trim()))throw new VisibilityError('INVALID_TEXT');return v.trim();}
export const fingerprint=(v:unknown)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function visibilityTransaction<T>(fn:(db:any)=>Promise<T>):Promise<T>{const db=await pool.connect();try{await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
export async function visibilityManager(actorId:string,merchantId:string,db:any=pool){visibilityId(merchantId);
 const {rows:[m]}=await db.query(`SELECT mp.* FROM konektag.merchant_profiles mp LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id=mp.id AND mm.user_id=$2
 WHERE mp.id=$1 AND mp.deleted_at IS NULL AND CASE WHEN mm.id IS NOT NULL THEN mm.status='active' AND mm.removed_at IS NULL AND mm.role IN ('owner','manager') ELSE mp.user_id=$2 END`,[merchantId,actorId]);
 if(!m)throw new VisibilityError('MERCHANT_ACCESS_DENIED',403);return m;
}
export async function visibilityAdmin(actorId:string,db:any=pool){const {rows}=await db.query("SELECT id FROM konektag.users WHERE id=$1 AND role='admin' AND deleted_at IS NULL AND access_status IS DISTINCT FROM 'BLOCKED'",[actorId]);if(!rows.length)throw new VisibilityError('ADMIN_REQUIRED',403);}
export function publicSite(){const raw=process.env.PUBLIC_SITE_URL;if(!raw)throw new VisibilityError('PUBLIC_SITE_URL_REQUIRED',503);const u=new URL(raw);if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))||u.username||u.password)throw new VisibilityError('PUBLIC_SITE_URL_INVALID',503);return u.origin;}
export async function publishedMerchant(merchantId:string,db:any=pool){visibilityId(merchantId);
 const {rows:[m]}=await db.query(`SELECT mp.*,n.snapshot AS published_snapshot FROM konektag.merchant_profiles mp
 LEFT JOIN LATERAL(SELECT snapshot FROM konektag.merchant_n2_publication_snapshots WHERE merchant_profile_id=mp.id ORDER BY version DESC LIMIT 1) n ON true
 WHERE mp.id=$1 AND mp.deleted_at IS NULL AND mp.status<>'Suspended' AND n.snapshot IS NOT NULL`,[merchantId]);
 if(!m)throw new VisibilityError('MERCHANT_NOT_PUBLIC',409);
 if(!m.published_snapshot?.merchant)throw new VisibilityError('PUBLIC_SNAPSHOT_REQUIRED',409);
 const p=m.published_snapshot.merchant;
 if(!p.businessName||!p.city||!p.country||!p.slug)throw new VisibilityError('PUBLIC_PROFILE_INCOMPLETE',409);
 const snapshot={businessName:p.businessName,city:p.city,country:p.country,slug:p.slug,description:p.shortDescription||p.longDescription||'',imageUrl:p.coverImageUrl||p.logoUrl||null};
 return {...snapshot,url:new URL(marketplaceMerchantPath('fr',p.city,p.slug),publicSite()).href};
}
export function visibilityJson(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
export async function visibilityHttp(fn:()=>Promise<unknown>){try{const v=await fn();return v instanceof Response?v:visibilityJson(v);}catch(e){if(e instanceof VisibilityError)return visibilityJson({error:e.code},e.status);console.error('[merchant-visibility] Operation failed');return visibilityJson({error:'SERVER_ERROR'},500);}}
export function visibilityActor(locals:RequestContext['locals']){if(!locals.user?.id)throw new VisibilityError('UNAUTHORIZED',401);return locals.user.id;}
export async function visibilityBody(r:Request){if(!r.headers.get('content-type')?.includes('application/json'))throw new VisibilityError('JSON_REQUIRED',415);let b;try{b=await r.json();}catch{throw new VisibilityError('INVALID_JSON',400);}if(!b||typeof b!=='object'||Array.isArray(b))throw new VisibilityError('INVALID_JSON',400);return b as Record<string,unknown>;}
