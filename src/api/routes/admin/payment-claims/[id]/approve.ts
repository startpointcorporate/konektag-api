import type { RouteHandler } from '../../../../http';
import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../../../infrastructure/database/pool.ts';
import { apiPaymentCheckoutService } from '../../../../../application/services/pay/api-payment-checkout-service.ts';

export const POST: RouteHandler = async ({locals,request,params}) => {
  if(!locals.user?.id) return Response.json({error:'FORBIDDEN'},{status:403});
  const {rows:[actor]}=await pool.query(`SELECT role FROM konektag.users WHERE id=$1`,[locals.user.id]);
  if(!actor || !['admin','operations','finance_local','approver'].includes(actor.role)) return Response.json({error:'FORBIDDEN'},{status:403});
  const claimId=params.id||'';
  if(!/^[0-9a-f-]{36}$/i.test(claimId)) return Response.json({error:'INVALID_ID'},{status:400});
  const body=await request.json().catch(()=>({}));
  const providerReference=typeof body.providerReference==='string'?body.providerReference.trim():'';
  const evidenceRef=typeof body.evidenceRef==='string'?body.evidenceRef.trim():'';
  if(!providerReference || !evidenceRef) return Response.json({error:'MANUAL_PROOF_REQUIRED'},{status:400});

  const client=await pool.connect(); let order:any,eventId:string|undefined;
  try{
    await client.query('BEGIN');
    const {rows:[claim]}=await client.query(`SELECT * FROM konektag.payment_claims WHERE id=$1 FOR UPDATE`,[claimId]);
    if(!claim || !claim.payment_order_id || !['PENDING_REVIEW','OPEN','AUTO_RECONCILING'].includes(claim.status))
      throw Object.assign(new Error('CLAIM_NOT_REVIEWABLE'),{statusCode:409});
    const {rows:[o]}=await client.query(`SELECT * FROM konektag.api_payment_orders WHERE id=$1 FOR UPDATE`,[claim.payment_order_id]);
    if(!o || o.order_purpose!=='wallet_recharge') throw Object.assign(new Error('PAYMENT_NOT_FOUND'),{statusCode:404});
    order=o;
    const method=o.payment_method==='card'?'card':'mobile_money';
    const expectedMinor=Math.round(Number(o.external_amount)*(['XOF','XAF','XPF','JPY','KRW','VND','BIF','CLP','DJF','GNF','KMF','MGA','PYG','RWF','UGX','VUV'].includes(o.currency)?1:100));
    const attemptId=randomUUID();
    await client.query(`INSERT INTO konektag.payment_provider_attempts
      (id,source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency,state,metadata)
      VALUES($1,'api_payment',$2,$2,'manual',$3,$4,$5,'succeeded',$6)
      ON CONFLICT(provider,provider_reference) DO NOTHING`,
      [attemptId,o.id,providerReference,expectedMinor,o.currency,JSON.stringify({claimId,evidenceRef,approvedBy:locals.user.id})]);
    const {rows:[attempt]}=await client.query(`SELECT id FROM konektag.payment_provider_attempts WHERE provider='manual' AND provider_reference=$1 AND source_id::text=$2::text`,[providerReference,o.id]);
    if(!attempt) throw Object.assign(new Error('MANUAL_PROOF_CONFLICT'),{statusCode:409});
    const providerEventId=`claim:${claimId}:${providerReference}`;
    const hash=createHash('sha256').update(JSON.stringify({claimId,orderId:o.id,providerReference,evidenceRef,expectedMinor,currency:o.currency})).digest('hex');
    const {rows:[evt]}=await client.query(`INSERT INTO konektag.payment_provider_events(provider,provider_event_id,attempt_id,event_type,payload_hash)
      VALUES('manual',$1,$2,'payment_claim.approved',$3)
      ON CONFLICT(provider,provider_event_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id RETURNING id`,
      [providerEventId,attempt.id,hash]);
    eventId=evt.id;
    await client.query(`UPDATE konektag.api_payment_orders SET payment_method=$2,funding_state='external_started',
      state=CASE WHEN state='paid' THEN state ELSE 'processing' END,updated_at=now() WHERE id=$1`,[o.id,method]);
    await client.query(`UPDATE konektag.payment_claims SET status='APPROVED',provider='manual',provider_reference=$2,
      resolution='Manual evidence approved',resolved_by=$3,updated_at=now() WHERE id=$1`,[claimId,providerReference,locals.user.id]);
    await client.query('COMMIT');
  }catch(error:any){
    await client.query('ROLLBACK').catch(()=>undefined); client.release();
    return Response.json({error:error?.message||'CLAIM_APPROVAL_FAILED'},{status:error?.statusCode||500});
  }
  client.release();

  try{
    const method=order.payment_method==='card'?'card':'mobile_money';
    await apiPaymentCheckoutService.markFinalAndDispatch(order.id,method,providerReference,eventId);
    await pool.query(`UPDATE konektag.payment_provider_events SET processed_at=now() WHERE id=$1`,[eventId]);
    await pool.query(`UPDATE konektag.payment_claims SET status='CREDITED',resolved_at=now(),updated_at=now() WHERE id=$1`,[claimId]);
    return Response.json({success:true,status:'CREDITED'});
  }catch(error:any){
    await pool.query(`UPDATE konektag.payment_claims SET status='PENDING_REVIEW',resolution=$2,updated_at=now() WHERE id=$1`,[claimId,String(error?.message||'reconciliation failed').slice(0,500)]);
    return Response.json({error:'RECONCILIATION_FAILED'},{status:409});
  }
};
