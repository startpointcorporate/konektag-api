import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { resolvePointsOwner } from '../../../../application/services/pay/points-wallet-service.ts';
import { exchangeRateService } from '../../../../application/services/exchange-rate-service.ts';

const STATUSES=['PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED'] as const;

export const GET:RouteHandler=async({request,locals})=>{
 try{
  const user=locals.user;if(!user)return Response.json({error:'UNAUTHORIZED'},{status:401});
  const url=new URL(request.url);
  const limit=Math.min(Math.max(Number(url.searchParams.get('limit')||50),1),100);
  const offset=Math.max(Number(url.searchParams.get('offset')||0),0);
  if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))return Response.json({error:'INVALID_PAGINATION'},{status:400});
  const {rows:[profile]}=await pool.query(`SELECT up.preferred_currency,u.country FROM konektag.users u
   LEFT JOIN konektag.user_preferences up ON up.user_id=u.id AND up.deleted_at IS NULL WHERE u.id=$1`,[user.id]);
  const currency=(url.searchParams.get('currency')||profile?.preferred_currency||'EUR').trim().toUpperCase();
  if(!exchangeRateService.isSupported(currency))return Response.json({error:'UNSUPPORTED_CURRENCY'},{status:400});
  const partyId=await resolvePointsOwner(pool as any,user.id);
  const {rows}=await pool.query(`WITH movements AS (
   SELECT le.created_at,ft.transaction_type AS operation_type,le.entry_side AS direction,
    le.amount AS quantity_k,le.document_type AS source_type,le.document_ref AS source_id,
    ft.id::text AS operation_id,u.username AS counterparty,
    CASE WHEN ft.status='pending' AND ft.accounting_status='processing' THEN 'PROCESSING'
      WHEN ft.status='pending' THEN 'PENDING' WHEN ft.status='failed' THEN 'FAILED'
      WHEN ft.status IN ('completed','reversed') THEN 'COMPLETED' ELSE 'FAILED' END AS status,
    ft.business_reference,pc.currency AS original_currency,pc.confirmed_minor AS original_amount_minor,
    pc.provider AS original_provider,le.id::text AS stable_id
   FROM konektag.ledger_entries le
   JOIN konektag.financial_transactions ft ON ft.id=le.transaction_id
   LEFT JOIN konektag.ledger_entries peer ON peer.transaction_id=le.transaction_id AND peer.account_code='1000'
    AND peer.party_id<>le.party_id AND peer.entry_side<>le.entry_side
   LEFT JOIN konektag.parties cp ON cp.id=peer.party_id
   LEFT JOIN konektag.users u ON u.keycloak_id=cp.keycloak_id AND u.deleted_at IS NULL
   LEFT JOIN konektag.points_acquisitions pa ON pa.transaction_id=ft.id
   LEFT JOIN konektag.points_payment_confirmations pc ON pc.order_id=pa.order_id
   WHERE le.party_id=$1 AND le.account_code='1000' AND le.currency='K' AND le.gl_scope='GLOBAL_USER_GL'
   UNION ALL
   SELECT o.updated_at,'acquisition','credit',
    o.points_quantity::numeric,'payment_order',o.id::text,o.id::text,NULL,
    CASE WHEN attempt.state IN ('failed') THEN 'FAILED'
      WHEN attempt.state IN ('cancelled','expired') THEN 'CANCELLED'
      WHEN o.state IN ('processing','awaiting_mobile_money') OR attempt.state='processing' THEN 'PROCESSING'
      WHEN o.state='pending' THEN 'PENDING' WHEN o.state IN ('cancelled','expired') THEN 'CANCELLED'
      ELSE 'FAILED' END,
    COALESCE(o.order_metadata #>> '{erpnextPointsK,paymentRequest}',o.merchant_transaction_id),
    o.currency,o.subtotal_amount,
    COALESCE(attempt.provider,o.settlement_provider,o.order_metadata #>> '{erpnextPointsK,provider}'),o.id::text
   FROM konektag.api_payment_orders o
   LEFT JOIN LATERAL (SELECT a.state,a.provider FROM konektag.payment_provider_attempts a
    WHERE a.source_type='api_payment' AND a.source_id::text=o.id::text
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1) attempt ON true
   WHERE o.target_user_id=$2 AND o.order_purpose='wallet_recharge'
    AND o.order_metadata ? 'erpnextPointsK'
    AND o.points_quantity>0
    AND o.state IN ('pending','processing','awaiting_mobile_money','failed','expired','cancelled')
    AND NOT EXISTS(SELECT 1 FROM konektag.ledger_entries le WHERE le.points_order_id=o.id)
  )
  SELECT movements.*,count(*) OVER()::int AS total FROM movements
  ORDER BY created_at DESC,stable_id DESC LIMIT $3 OFFSET $4`,[partyId,user.id,limit,offset]);
  const rate=await exchangeRateService.getRate('EUR',currency);
  if(rate===null)return Response.json({error:'EXCHANGE_RATE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});
  const evidence=await exchangeRateService.getRateEvidence('EUR',currency);
  const items=rows.map((w:any)=>{
   const credit=w.direction==='credit';const signed=credit?Number(w.quantity_k):-Number(w.quantity_k);
   const type=w.operation_type==='purchase'?'Achat de K'
    :w.operation_type==='k_send'?(credit?'K reçus':'K envoyés')
    :w.operation_type==='payment'?'Paiement en K'
    :w.operation_type==='cashback'?'Cashback'
    :w.operation_type==='bonus'?'Bonus K'
    :w.operation_type==='refund'?'Remboursement':'Points K';
   const detail=w.operation_type==='k_send'
    ?(credit?'Reçu de ':'Vers ')+(w.counterparty||'Utilisateur Konektag'):type;
   const status=STATUSES.includes(w.status)?w.status:'COMPLETED';
   return {date:w.created_at,type:w.operation_type,label:type,detail,quantityK:signed,
    value:{amount:Math.round(signed*rate*1e6)/1e6,currency,rate,rateSource:evidence?.source??'static_fallback',
     rateDate:evidence?.valuedAt??null,kind:'INDICATIVE'},
    original:w.original_currency?{amountMinor:Number(w.original_amount_minor),currency:w.original_currency,
     provider:w.original_provider}:{amountMinor:null,currency:null,provider:null},
    reference:w.business_reference||w.source_id,status,counterparty:w.counterparty||null,
    operationId:w.operation_id,sourceType:w.source_type};
  });
  return Response.json({items,pagination:{limit,offset,total:Number(rows[0]?.total??0)},statuses:STATUSES},
   {headers:{'Cache-Control':'no-store'}});
 }catch(error){
  console.error('[account/history] wallet history failed',{name:error instanceof Error?error.name:'UnknownError'});
  return Response.json({error:'WALLET_HISTORY_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});
 }
};
