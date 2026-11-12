import { requireFinancialAccountActive } from './wallet-integrity-service.ts';
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
 const {rows:[existing]}=await db.query(`SELECT id,party_id,recipient_party_id,quantity,status FROM konektag.k_operations WHERE operation_key=$1`,[input.operationKey]);
 if(existing){
  if(existing.party_id!==input.senderPartyId || existing.recipient_party_id!==input.recipientPartyId || Number(existing.quantity)!==input.quantityK || existing.status!=='completed') throw new Error('K_SEND_IDEMPOTENCY_CONFLICT');
  return existing.id;
 }
 await requireFinancialAccountActive(db,input.senderPartyId);
 const balance=await kPointsBalance(input.senderPartyId,db);
 if(balance.available<input.quantityK)throw new Error('K_SEND_INSUFFICIENT');
 const {rows:[operation]}=await db.query(`INSERT INTO konektag.k_operations
  (operation_key,operation_type,party_id,recipient_party_id,quantity)
  VALUES($1,'k_send',$2,$3,$4) RETURNING id`,
  [input.operationKey,input.senderPartyId,input.recipientPartyId,input.quantityK]);
 await db.query(`INSERT INTO konektag.ledger_entries
  (k_operation_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,operation_id,value_date)
  VALUES($1,'1000','debit','debit',$2,$4,'K','k_send',$5,$5,CURRENT_DATE),
        ($1,'1000','credit','credit',$3,$4,'K','k_send',$5,$5,CURRENT_DATE)`,
  [operation.id,input.senderPartyId,input.recipientPartyId,input.quantityK,input.operationKey]);
 await db.query(`UPDATE konektag.k_operations SET status='completed',completed_at=now() WHERE id=$1`,[operation.id]);
 return operation.id;
}
