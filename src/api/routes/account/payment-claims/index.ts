import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { apiPaymentCheckoutService } from '../../../../application/services/pay/api-payment-checkout-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  if (!locals.user?.id) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const {rows}=await pool.query(
    `SELECT id,payment_order_id AS "paymentOrderId",provider,provider_reference AS "providerReference",
      claimed_amount AS "claimedAmount",currency,reason,evidence_ref AS "evidenceRef",status,resolution,created_at AS "createdAt",updated_at AS "updatedAt"
     FROM konektag.payment_claims WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[locals.user.id]);
  return Response.json({claims:rows});
};

export const POST: RouteHandler = async ({ locals, request }) => {
  if (!locals.user?.id) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const body=await request.json().catch(()=>({}));
  const orderId=typeof body.paymentOrderId==='string'?body.paymentOrderId:null;
  if (orderId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) return Response.json({error:'INVALID_PAYMENT_ORDER'},{status:400});
  const providerReference=typeof body.providerReference==='string'?body.providerReference.trim():null;
  const reason=typeof body.reason==='string'?body.reason.trim():'';
  const evidenceRef=typeof body.evidenceRef==='string'?body.evidenceRef.trim():null;
  if(!reason || (!orderId && !providerReference)) return Response.json({error:'INVALID_CLAIM'},{status:400});

  const client=await pool.connect();
  let claim:any; let recovery:any=null;
  try{
    await client.query('BEGIN');
    if(orderId){
      const {rows:[order]}=await client.query(
        `SELECT id,target_user_id FROM konektag.api_payment_orders WHERE id=$1 FOR UPDATE`,[orderId]);
      if(!order || order.target_user_id!==locals.user.id) throw Object.assign(new Error('PAYMENT_NOT_FOUND'),{statusCode:404});
    }
    const {rows:[created]}=await client.query(
      `INSERT INTO konektag.payment_claims(user_id,payment_order_id,provider_reference,reason,evidence_ref,status)
       VALUES($1,$2,$3,$4,$5,'OPEN') RETURNING *`,
      [locals.user.id,orderId,providerReference,reason,evidenceRef]);
    claim=created;
    const {rows:[match]}=await client.query(
      `SELECT e.id AS event_id,a.source_id,a.provider,a.provider_reference
       FROM konektag.payment_provider_attempts a
       JOIN konektag.payment_provider_events e ON e.attempt_id=a.id AND e.failed_at IS NULL
       JOIN konektag.api_payment_orders o ON o.id::text=a.source_id::text
       WHERE a.source_type='api_payment' AND a.state='succeeded' AND o.target_user_id=$1
         AND ($2::uuid IS NULL OR o.id=$2::uuid)
         AND ($3::text IS NULL OR a.provider_reference=$3)
       ORDER BY e.received_at DESC LIMIT 1`,
      [locals.user.id,orderId,providerReference]);
    if(match){
      recovery=match;
      await client.query(`UPDATE konektag.payment_claims SET status='AUTO_RECONCILING',provider=$2,provider_reference=$3,updated_at=now() WHERE id=$1`,
        [claim.id,match.provider,match.provider_reference]);
    }else{
      await client.query(`UPDATE konektag.payment_claims SET status='PENDING_REVIEW',updated_at=now() WHERE id=$1`,[claim.id]);
    }
    await client.query('COMMIT');
  }catch(error:any){
    await client.query('ROLLBACK').catch(()=>undefined);
    if(error?.statusCode===404) return Response.json({error:'PAYMENT_NOT_FOUND'},{status:404});
    if(error?.code==='23505') return Response.json({error:'CLAIM_ALREADY_OPEN'},{status:409});
    return Response.json({error:'CLAIM_CREATION_FAILED'},{status:500});
  }finally{client.release();}

  if(recovery){
    try{
      const method=recovery.provider==='stripe'?'card':'mobile_money';
      await apiPaymentCheckoutService.markFinalAndDispatch(recovery.source_id,method,recovery.provider_reference,recovery.event_id);
      await pool.query(`UPDATE konektag.payment_claims SET status='CREDITED',resolution='Verified provider payment reconciled',resolved_at=now(),updated_at=now() WHERE id=$1`,[claim.id]);
    }catch{
      await pool.query(`UPDATE konektag.payment_claims SET status='PENDING_REVIEW',updated_at=now() WHERE id=$1`,[claim.id]);
    }
  }
  const {rows:[result]}=await pool.query(`SELECT id,status,payment_order_id AS "paymentOrderId",provider_reference AS "providerReference" FROM konektag.payment_claims WHERE id=$1`,[claim.id]);
  return Response.json({claim:result},{status:201});
};
