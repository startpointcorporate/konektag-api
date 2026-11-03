import type { RequestContext } from '../../http';
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { controlAction, financialAccountStatus, walletSnapshot, type ControlAction } from '../../../application/services/wallet-integrity-service.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
async function admin(locals:RequestContext['locals']) {
 if(!locals.user) return null;
 const {rows:[u]}=await pool.query("SELECT id FROM konektag.users WHERE id=$1 AND role='admin' AND deleted_at IS NULL",[locals.user.id]);
 return u?.id??null;
}
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export const GET:RouteHandler=async({locals,url})=> {
 if(!await admin(locals)) return json({error:'FORBIDDEN'},403);
 const partyId=url.searchParams.get('partyId');
 if(partyId) {
  if(!uuid(partyId)) return json({error:'INVALID_PARTY'},400);
  const db=await pool.connect();
  try {
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const snapshot=await walletSnapshot(db,partyId);
   const control=await financialAccountStatus(db,partyId);
   const {rows:alerts}=await db.query('SELECT * FROM konektag.wallet_integrity_alerts WHERE party_id=$1 ORDER BY detected_at DESC',[partyId]);
   const {rows:events}=await db.query('SELECT * FROM konektag.financial_account_control_events WHERE party_id=$1 ORDER BY created_at DESC',[partyId]);
   await db.query('COMMIT');return json({snapshot,control,alerts,events});
  } catch {await db.query('ROLLBACK');return json({error:'INVESTIGATION_UNAVAILABLE'},500);}
  finally {db.release();}
 }
 const page=Math.max(0,Math.min(100000,Number(url.searchParams.get('page'))||0));
 const {rows}=await pool.query(`SELECT a.*,u.username,u.id AS user_id,c.status AS financial_status,c.version
  FROM konektag.wallet_integrity_alerts a JOIN konektag.parties p ON p.id=a.party_id
  LEFT JOIN konektag.users u ON u.keycloak_id=p.keycloak_id
  LEFT JOIN konektag.financial_account_controls c ON c.party_id=a.party_id
  ORDER BY a.detected_at DESC,a.id LIMIT 100 OFFSET $1`,[Math.floor(page)*100]);
 return json({alerts:rows,page});
};
export const POST:RouteHandler=async({locals,request,url})=> {
 const actorId=await admin(locals);if(!actorId) return json({error:'FORBIDDEN'},403);
 if(request.headers.get('origin')!==url.origin) return json({error:'INVALID_ORIGIN'},403);
 let body:any;try{body=await request.json();}catch{return json({error:'INVALID_JSON'},400);}
 const actions:ControlAction[]=['ACKNOWLEDGE','FALSE_POSITIVE','RELEASE','MAINTAIN','RECHECK'];
 if(!body||typeof body!=='object'||Array.isArray(body)||!uuid(body.partyId)||!actions.includes(body.action)||typeof body.reason!=='string'||body.reason.trim().length<8
  ||body.reason.length>2000||!Number.isSafeInteger(body.version)||body.version<0||(body.alertId&&!uuid(body.alertId))) return json({error:'INVALID_REQUEST'},400);
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const result=await controlAction(db,{partyId:body.partyId,actorId,action:body.action,reason:body.reason.trim(),version:body.version,alertId:body.alertId});
  await db.query('COMMIT');return json(result);
 } catch(error) {
  await db.query('ROLLBACK');
  const message=error instanceof Error?error.message:'';
  return json({error:['CRITICAL_ANOMALY_REMAINS','FINANCIAL_CONTROL_VERSION_CONFLICT','CURRENT_ALERT_REQUIRED'].includes(message)?message:'FINANCIAL_CONTROL_FAILED'},409);
 } finally {db.release();}
};
