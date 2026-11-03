import { requireFinancialAccountActive } from './wallet-integrity-service.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';
type Database=Pick<PoolClient,'query'>;

export async function kPointsBalance(partyId:string,db:Database=pool){
 const {rows:[row]}=await db.query('SELECT * FROM konektag.points_balance($1)',[partyId]);
 const balance=Number(row?.balance??0);
 const reserved=Number(row?.reserved??0);
 if(!Number.isSafeInteger(balance)||!Number.isSafeInteger(reserved))throw new Error('WALLET_BALANCE_RANGE_ERROR');
 return {balance,reserved,available:balance-reserved,unit:'K' as const};
}

export async function ensureKParty(db:Database,userId:string):Promise<{id:string;keycloak_id:string}>{
 const {rows:[user]}=await db.query(`SELECT id,keycloak_id,COALESCE(username,'Utilisateur') AS display_name FROM konektag.users WHERE id=$1 AND deleted_at IS NULL`,[userId]);
 if(!user?.keycloak_id)throw new Error('K_POINTS_USER_UNAVAILABLE');
 const {rows:[party]}=await db.query(`INSERT INTO konektag.parties(party_type,keycloak_id,display_name)
 VALUES('individual',$1::uuid,$2) ON CONFLICT(keycloak_id) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id,keycloak_id,is_active`,[user.keycloak_id,user.display_name]);
 if(!party?.is_active)throw new Error('K_POINTS_OWNER_UNAVAILABLE');return party;
}

export async function transferKPoints(db:Database,input:{senderPartyId:string;recipientPartyId:string;quantityK:number;operationKey:string}):Promise<string>{
 if(!Number.isSafeInteger(input.quantityK)||input.quantityK<=0)throw new Error('INVALID_K_SEND_QUANTITY');
 if(input.senderPartyId===input.recipientPartyId)throw new Error('K_SEND_TO_SELF_FORBIDDEN');
 const first=input.senderPartyId<input.recipientPartyId?input.senderPartyId:input.recipientPartyId;
 const second=first===input.senderPartyId?input.recipientPartyId:input.senderPartyId;
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`points-wallet:${first}`]);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`points-wallet:${second}`]);
 const {rows:[existing]}=await db.query(`SELECT operation_id,party_id,counterparty_party_id,quantity_k FROM konektag.k_wallet_entries WHERE source_type='k_send' AND source_id=$1 AND direction='debit' LIMIT 1`,[input.operationKey]);
 if(existing){
  if(existing.party_id!==input.senderPartyId || existing.counterparty_party_id!==input.recipientPartyId || Number(existing.quantity_k)!==input.quantityK) throw new Error('K_SEND_IDEMPOTENCY_CONFLICT');
  return existing.operation_id;
 }
 await requireFinancialAccountActive(db,input.senderPartyId);
 const balance=await kPointsBalance(input.senderPartyId,db);
 if(balance.available<input.quantityK)throw new Error('K_SEND_INSUFFICIENT');
 const operationId=randomUUID();
 await db.query(`INSERT INTO konektag.k_wallet_entries
  (party_id,operation_id,operation_type,direction,quantity_k,counterparty_party_id,source_type,source_id)
  VALUES($1,$3,'k_send','debit',$4,$2,'k_send',$5),
        ($2,$3,'k_send','credit',$4,$1,'k_send',$5)`,
  [input.senderPartyId,input.recipientPartyId,operationId,input.quantityK,input.operationKey]);
 return operationId;
}
