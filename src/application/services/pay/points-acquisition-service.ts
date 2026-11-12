import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { resolvePointsOwner } from './points-wallet-service.ts';
import { minorDigits } from './money-unit.ts';

export interface ConfirmPointsAcquisitionInput {
  orderId: string;
  userId: string;
  provider: 'stripe' | 'pawapay' | 'manual';
  providerReference: string;
  providerEventId: string;
  attemptId: string;
  confirmedMinor: number;
  currency: string;
  pointsQuantity: number;
  lotValueMinor: number;
  legalEntityId: string;
  corridorId: string;
  regulatoryProfileId: string;
}

export async function confirmPointsAcquisition(db: PoolClient, input: ConfirmPointsAcquisitionInput): Promise<{ transactionId:string; acquisitionId:string }> {
  if (!Number.isSafeInteger(input.pointsQuantity) || input.pointsQuantity <= 0) throw new Error('POINTS_QUANTITY_INVALID');
  if (!Number.isSafeInteger(input.lotValueMinor) || input.lotValueMinor <= 0) throw new Error('POINTS_LOT_VALUE_INVALID');
  if (!Number.isSafeInteger(input.confirmedMinor) || input.confirmedMinor <= 0) throw new Error('POINTS_PAYMENT_AMOUNT_INVALID');

  const partyId = await resolvePointsOwner(db, input.userId);
  const lotId = `PK-ORDER-${input.orderId}`;
  const acquisitionKey = `points-acquisition:${input.orderId}`;

  const { rows:[existing] } = await db.query(
    `SELECT id,transaction_id,status FROM konektag.points_acquisitions WHERE order_id=$1 FOR UPDATE`, [input.orderId]);
  if (existing?.status === 'completed' && existing.transaction_id) {
    return { transactionId: existing.transaction_id, acquisitionId: existing.id };
  }

  if (!input.providerEventId) throw new Error('POINTS_PROVIDER_EVENT_REQUIRED');

  await db.query(
    `INSERT INTO konektag.points_payment_confirmations
      (order_id,event_id,attempt_id,provider,provider_reference,confirmed_minor,currency)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(order_id) DO NOTHING`,
    [input.orderId,input.providerEventId,input.attemptId,input.provider,input.providerReference,input.confirmedMinor,input.currency]);

  await db.query(
    `INSERT INTO konektag.points_lots(id,currency,value_minor,quantity,active,provider,order_id)
     VALUES($1,$2,$3,$4,true,$5,$6)
     ON CONFLICT(id) DO NOTHING`,
    [lotId,input.currency,input.lotValueMinor,input.pointsQuantity,input.provider,input.orderId]);

  const { rows:[acq] } = await db.query(
    `INSERT INTO konektag.points_acquisitions(order_id,party_id,lot_id,quantity,idempotency_key,status,attempt_count)
     VALUES($1,$2,$3,$4,$5,'processing',1)
     ON CONFLICT(order_id) DO UPDATE SET attempt_count=konektag.points_acquisitions.attempt_count+1,status='processing',last_error=NULL,next_attempt_at=now()
     RETURNING id`,
    [input.orderId,partyId,lotId,input.pointsQuantity,acquisitionKey]);

  const txId = crypto.randomUUID();
  const operationId = `POINTS-ACQ-${input.orderId}`;
  await db.query(
    `INSERT INTO konektag.financial_transactions
      (id,transaction_type,business_reference,idempotency_key,currency,status,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,eligibility_decision)
     VALUES($1,'acquisition',$2,$3,'K','pending',$4,$5,$6,$7,CURRENT_DATE,'ALLOWED')`,
    [txId,operationId,acquisitionKey,input.legalEntityId,input.corridorId,operationId,input.regulatoryProfileId]);

  const klotId = crypto.randomUUID();
  await db.query(
    `INSERT INTO konektag.klots
      (id,klot_ref,origin_entity_id,origin_country,rail,rail_ref,issuer,quantity_k,remaining_quantity,economic_currency,economic_value,regulatory_profile_id,status)
     SELECT $1::uuid,$2::varchar,$3::uuid,le.country_code,$4::varchar,$5::varchar,'Konektag',
            $6::numeric,$6::numeric,$7::varchar,$8::numeric,$9::uuid,'VALUATED'
     FROM konektag.legal_entities le WHERE le.id=$3::uuid`,
    [klotId,`KLOT-POINTS-${input.orderId}`,input.legalEntityId,input.provider,input.providerReference,input.pointsQuantity,input.currency,input.lotValueMinor/(10 ** minorDigits(input.currency)),input.regulatoryProfileId]);

  const legs = [
    ['K_ISSUANCE','debit',null,'issuance_debit'],
    ['K_ALLOCATION_CLEARING','credit',null,'issuance_credit'],
    ['K_ALLOCATION_CLEARING','debit',null,'allocation_debit'],
    ['1000','credit',partyId,'allocation_credit'],
  ] as const;
  for (const [account,side,party,leg] of legs) {
    await db.query(
      `INSERT INTO konektag.ledger_entries
        (transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,
         legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,klot_id,
         points_order_id,points_acquisition_id,points_lot_id,points_leg)
       VALUES($1,$2,$3,$3,$4,$5,'K','points_acquisition',$6,$7,$8,$9,$10,CURRENT_DATE,$11,$12,$13,$14,$15)`,
      [txId,account,side,party,input.pointsQuantity,operationId,input.legalEntityId,input.corridorId,operationId,input.regulatoryProfileId,klotId,input.orderId,acq.id,lotId,leg]);
  }

  await db.query(`UPDATE konektag.financial_transactions SET status='completed',completed_at=now(),klot_id=$2 WHERE id=$1`,[txId,klotId]);
  await db.query(`UPDATE konektag.points_payment_confirmations SET applied_at=now() WHERE order_id=$1 AND applied_at IS NULL`,[input.orderId]);
  await db.query(
    `INSERT INTO konektag.outbox_events(correlation_id,causation_id,aggregate_type,aggregate_id,aggregate_ref,event_type,event_version,payload)
     VALUES($1,$1,'PointsAcquisition',$2,$3,'PointsAcquisitionCompleted',1,$4)`,
    [crypto.randomUUID(),acq.id,input.orderId,JSON.stringify({orderId:input.orderId,userId:input.userId,partyId,quantity:input.pointsQuantity,transactionId:txId})]);
  await db.query(
    `UPDATE konektag.points_acquisitions SET status='completed',transaction_id=$2,klot_id=$3,completed_at=now(),last_error=NULL WHERE id=$1`,
    [acq.id,txId,klotId]);
  await db.query(
    `UPDATE konektag.api_payment_orders SET points_quantity=$2,lot_value_minor=$3,confirmed_payment_minor=$4,payment_status='confirmed',
      acquisition_status='completed',recharge_lot_id=$5,updated_at=now()
     WHERE id=$1`,
    [input.orderId,input.pointsQuantity,input.lotValueMinor,input.confirmedMinor,lotId]);

  return { transactionId:txId, acquisitionId:acq.id };
}
