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
  const {rows}=await pool.query(`SELECT w.created_at,w.operation_type,w.direction,w.quantity_k,w.source_type,w.source_id,
    w.operation_id,u.username AS counterparty,
    COALESCE(upper(ft.status),'COMPLETED') AS status,
    ft.business_reference,ft.currency AS original_currency,
    count(*) OVER()::int AS total
   FROM konektag.k_wallet_entries w
   LEFT JOIN konektag.financial_transactions ft ON ft.id=w.operation_id
   LEFT JOIN konektag.parties cp ON cp.id=w.counterparty_party_id
   LEFT JOIN konektag.users u ON u.keycloak_id=cp.keycloak_id AND u.deleted_at IS NULL
   WHERE w.party_id=$1 ORDER BY w.created_at DESC,w.id DESC LIMIT $2 OFFSET $3`,[partyId,limit,offset]);
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
    original:{amountK:Number(w.quantity_k),currency:w.original_currency||'K'},
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
