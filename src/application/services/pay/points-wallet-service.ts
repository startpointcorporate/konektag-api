import { requireFinancialAccountActive } from '../wallet-integrity-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import { lockPointsOwner, confirmPointsReservation } from './points-reservation-service.ts';

type Database = Pick<PoolClient, 'query'>;

// Recording a verified receipt must survive a disabled/soft-deleted owner.
// Actual acquisition always uses the default strict availability check.
export async function resolvePointsOwner(db: Database, userId: string, recordReceiptOnly = false): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO konektag.parties(party_type,keycloak_id,display_name)
     SELECT 'individual',keycloak_id,COALESCE(username,'Utilisateur') FROM konektag.users
     WHERE id=$1 AND (deleted_at IS NULL OR $2)
     ON CONFLICT(keycloak_id) DO UPDATE SET keycloak_id=EXCLUDED.keycloak_id
     RETURNING id,is_active`, [userId,recordReceiptOnly]);
  if (!rows[0] || (!recordReceiptOnly && !rows[0].is_active)) throw new Error('POINTS_OWNER_UNAVAILABLE');
  return rows[0].id;
}

export async function pointsBalance(partyId: string, db: Database = pool) {
  const { rows: [row] } = await db.query(
    'SELECT * FROM konektag.points_balance($1)', [partyId]);
  const balance = Number(row.balance), reserved = Number(row.reserved ?? 0);
  return { balance, reserved, available: Number(row.available), unit: 'K' as const };
}

// Canonical extinction: no monetary amounts or merchant K account here.
export async function consumeReservedPoints(db: Database, input: {
  partyId:string; reservationId:string; operationKey:string; quantity:number;
  legalEntityId?:string; corridorId:string; regulatoryProfileId:string; orderId?:string;
}): Promise<string> {
  await lockPointsOwner(db,input.partyId);
  const {rows:[hold]}=await db.query(`SELECT *, expires_at<=statement_timestamp() AS expired
    FROM konektag.api_payment_wallet_reservations WHERE id=$1 AND payer_party_id=$2 AND currency='K' FOR UPDATE`,
    [input.reservationId,input.partyId]);
  if(!hold || Number(hold.amount)!==input.quantity) throw new Error('POINTS_RESERVATION_MISMATCH');
  if(hold.lifecycle==='captured' && hold.consumption_transaction_id) return hold.consumption_transaction_id;
  if(hold.lifecycle!=='active' || hold.expired) throw new Error('POINTS_RESERVATION_NOT_ACTIVE');
  await requireFinancialAccountActive(db,input.partyId);
  const balance=await pointsBalance(input.partyId,db);
  if(balance.balance<input.quantity || balance.available<0) throw new Error('POINTS_INSUFFICIENT');
  const {rows:[tx]}=await db.query(`INSERT INTO konektag.financial_transactions(transaction_type,business_reference,idempotency_key,
    currency,status,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,eligibility_decision)
    VALUES('consumption',$1,$2,'K','pending',$3,$4,$2,$5,CURRENT_DATE,'ALLOWED') RETURNING id`,
    [input.reservationId,input.operationKey,input.legalEntityId??null,input.corridorId,input.regulatoryProfileId]);
  for(const [account,side,party] of [['1000','debit',input.partyId],['K_ISSUANCE','credit',null]]) {
    await db.query(`INSERT INTO konektag.ledger_entries(transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,
      document_type,document_ref,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,points_order_id)
      VALUES($1,$2,$3,$3,$4,$5,'K','consumption',$6,$7,$8,$9,$10,CURRENT_DATE,$11)`,
      [tx.id,account,side,party,input.quantity,input.reservationId,input.legalEntityId??null,input.corridorId,input.operationKey,input.regulatoryProfileId,input.orderId??null]);
  }
  await db.query(`UPDATE konektag.financial_transactions SET status='completed',completed_at=now() WHERE id=$1`,[tx.id]);
  await confirmPointsReservation(db,{partyId:input.partyId,reservationId:hold.id,consumptionTransactionId:tx.id});
  return tx.id;
}

export async function consumeCheckoutPoints(db: Database, order: {
  id:string; payer_party_id:string|null; wallet_amount:number; currency:string;
  settlement_legal_entity_id:string|null; settlement_corridor_id:string|null; settlement_regulatory_profile_id:string|null;
}): Promise<string|undefined> {
  const quantity=Number(order.wallet_amount);
  if(!quantity) return;
  if(order.currency!=='EUR' || !order.payer_party_id || !Number.isSafeInteger(quantity) || quantity<0
    || !order.settlement_legal_entity_id || !order.settlement_corridor_id || !order.settlement_regulatory_profile_id)
    throw new Error('POINTS_CONSUMPTION_NOT_APPROVED');
  await lockPointsOwner(db,order.payer_party_id);
  const {rows:[hold]}=await db.query(`SELECT * FROM konektag.api_payment_wallet_reservations
    WHERE payment_order_id=$1 AND payer_party_id=$2 AND currency='K' FOR UPDATE`,[order.id,order.payer_party_id]);
  if(!hold) throw new Error('POINTS_RESERVATION_REQUIRED');
  return consumeReservedPoints(db,{partyId:order.payer_party_id,reservationId:hold.id,quantity,
    operationKey:`points-consumption:${order.id}`,orderId:order.id,legalEntityId:order.settlement_legal_entity_id,
    corridorId:order.settlement_corridor_id,regulatoryProfileId:order.settlement_regulatory_profile_id});
}

export async function sendPointsK(db: Database, input: {
  payerPartyId: string; recipientPartyId: string; quantity: number; operationKey: string;
  legalEntityId?: string; corridorId: string; regulatoryProfileId: string;
}): Promise<string> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('INVALID_POINTS_QUANTITY');
  const first = input.payerPartyId < input.recipientPartyId ? input.payerPartyId : input.recipientPartyId;
  const second = first === input.payerPartyId ? input.recipientPartyId : input.payerPartyId;
  await lockPointsOwner(db, first); await lockPointsOwner(db, second);
  await requireFinancialAccountActive(db,input.payerPartyId);
  if (input.payerPartyId === input.recipientPartyId) throw new Error('POINTS_SEND_TO_SELF_FORBIDDEN');
  const existing = await db.query(
    `SELECT ft.id,ft.currency,ft.status,ft.transaction_type,
            array_agg(le.party_id) FILTER (WHERE le.account_code='1000' AND le.entry_side='debit') AS payers,
            array_agg(le.party_id) FILTER (WHERE le.account_code='1000' AND le.entry_side='credit') AS recipients,
            count(le.id) AS entry_count,
            min(le.amount) AS min_quantity, max(le.amount) AS quantity
       FROM konektag.financial_transactions ft
       LEFT JOIN konektag.ledger_entries le ON le.transaction_id=ft.id
      WHERE ft.idempotency_key=$1
      GROUP BY ft.id`, [input.operationKey]);
  if (existing.rows[0]) {
    const row=existing.rows[0];
    if (row.currency!=='K' || row.status!=='completed' || row.transaction_type!=='k_send'
      || Number(row.entry_count)!==2 || Number(row.quantity)!==input.quantity || Number(row.min_quantity)!==input.quantity
      || row.payers?.length!==1 || row.payers[0]!==input.payerPartyId
      || row.recipients?.length!==1 || row.recipients[0]!==input.recipientPartyId) throw new Error('POINTS_SEND_REPLAY_CONFLICT');
    return row.id;
  }
  const balance = await pointsBalance(input.payerPartyId, db);
  if (balance.available < input.quantity) throw new Error('POINTS_INSUFFICIENT');
  const { rows: [tx] } = await db.query(`INSERT INTO konektag.financial_transactions
    (transaction_type,business_reference,idempotency_key,currency,status,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,eligibility_decision)
    VALUES('k_send',$1,$2,'K','pending',$3,$4,$2,$5,CURRENT_DATE,'ALLOWED') RETURNING id`,
    [input.operationKey,input.operationKey,input.legalEntityId??null,input.corridorId,input.regulatoryProfileId]);
  for (const [party, side] of [[input.payerPartyId,'debit'],[input.recipientPartyId,'credit']] as const) {
    await db.query(`INSERT INTO konektag.ledger_entries
      (transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date)
      VALUES($1,'1000',$2,$2,$3,$4,'K','k_send',$5,$6,$7,$8,$9,CURRENT_DATE)`,
      [tx.id,side,party,input.quantity,input.operationKey,input.legalEntityId??null,input.corridorId,input.operationKey,input.regulatoryProfileId]);
  }
  await db.query("UPDATE konektag.financial_transactions SET status='completed',completed_at=now() WHERE id=$1",[tx.id]);
  return tx.id;
}
