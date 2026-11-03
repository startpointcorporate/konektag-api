import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { ensureKParty } from '../../../../application/services/k-points-service.ts';

export const GET:RouteHandler=async({locals})=>{
 try{
  const user=locals.user;if(!user)return new Response(JSON.stringify([]),{status:200});
  const party=await ensureKParty(pool as any,user.id);
  const {rows}=await pool.query(`SELECT w.created_at,w.operation_type,w.direction,w.quantity_k,w.source_id,
    u.username AS counterparty
   FROM konektag.k_wallet_entries w
   LEFT JOIN konektag.parties cp ON cp.id=w.counterparty_party_id
   LEFT JOIN konektag.users u ON u.keycloak_id=cp.keycloak_id AND u.deleted_at IS NULL
   WHERE w.party_id=$1 ORDER BY w.created_at DESC LIMIT 50`,[party.id]);
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
   return {date:w.created_at,type,detail,amount:signed,symbol:'K',amountConverted:signed,symbolConverted:'K',status:'Complété'};
  });
  return new Response(JSON.stringify(items),{status:200});
 }catch{return new Response(JSON.stringify([]),{status:200});}
};
