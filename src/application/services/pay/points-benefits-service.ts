import { checkoutExpirationMinutes } from './checkout-expiration.ts';
import type { PoolClient } from 'pg';
import { lockPointsOwner } from './points-reservation-service.ts';
import { valueConsumedPointsK } from '../points-k-valuation-service.ts';
type Database=Pick<PoolClient,'query'>;

export async function pointsBenefitEligibility(db:Database,merchantId:string) {
  const {rows:[row]}=await db.query(`SELECT e.approval_reference FROM konektag.merchant_points_benefit_eligibility e
    JOIN konektag.merchant_profiles m ON m.id=e.merchant_profile_id
    WHERE e.merchant_profile_id=$1 AND e.physical_merchant AND e.approved
      AND e.valid_from<=statement_timestamp() AND (e.valid_until IS NULL OR e.valid_until>statement_timestamp())
      AND m.deleted_at IS NULL AND m.beneficiary_type='MERCHANT'`,[merchantId]);
  return {eligible:!!row,reference:row?.approval_reference??null};
}

// Monetary values enter as decimal strings and are calculated by PostgreSQL
// NUMERIC exclusively. No fee credit can reach the K ledger. The cashback base
// is the official EUR value of the consumed K, never the transaction amount.
export async function recordMerchantPointsConsumption(db:Database,input:{
  operationKey:string;partyId:string;merchantId:string;legalEntityId:string|null;quantity:number;
  transactionAmountMinor:number;transactionCurrency:string;paymentValuationProofHash?:string|null;
  kTransactionId:string;monetaryTransactionId:string;reservationId:string;
  rail:string;paymentCountry:string|null;
}) {
  await lockPointsOwner(db,input.partyId);
  const {rows:[existing]}=await db.query('SELECT * FROM konektag.points_merchant_consumptions WHERE operation_key=$1',[input.operationKey]);
  if(existing) {
    if(existing.party_id!==input.partyId || existing.k_transaction_id!==input.kTransactionId
      || existing.monetary_transaction_id!==input.monetaryTransactionId || existing.merchant_profile_id!==input.merchantId)
      throw new Error('POINTS_CONSUMPTION_REPLAY_CONFLICT');
    return existing;
  }
  const kValue=valueConsumedPointsK(input.quantity);
  const eligibility=await pointsBenefitEligibility(db,input.merchantId);
  const cashbackRail=input.rail==='qr'||input.rail==='payment_link';
  if(cashbackRail && !input.paymentCountry) throw new Error('PAYMENT_COUNTRY_REQUIRED');
  const {rows:[cashbackRule]}=cashbackRail?await db.query(`SELECT rate_bps,frappe_reference FROM konektag.payment_country_k_cashback_rules
    WHERE payment_country=$1 AND rail=$2 AND status='APPROVED' AND valid_from<=statement_timestamp()
      AND (valid_until IS NULL OR valid_until>statement_timestamp()) ORDER BY valid_from DESC LIMIT 1`,[input.paymentCountry,input.rail]):{rows:[]};
  // The cashback rate is recorded only when the cashback is actually granted.
  const cashbackRateBps=eligibility.eligible && cashbackRule ? Number(cashbackRule.rate_bps) : null;
  const {rows:[row]}=await db.query(`INSERT INTO konektag.points_merchant_consumptions
    (operation_key,party_id,merchant_profile_id,legal_entity_id,quantity,merchant_value,currency,
     k_transaction_id,monetary_transaction_id,reservation_id,eligible,eligibility_reference,payment_country,payment_rail,cashback_rate_bps,
     value_basis_version,transaction_amount_minor,transaction_currency,k_value_amount,k_value_currency,k_valuation_version,
     payment_valuation_proof_hash,cashback_amount,cashback_currency)
    SELECT $1,$2,$3,$4,$5,$6::numeric,$7::text,k.id,m.id,r.id,$11,$12,$13,$14,$15::int,
      2,$16,$17::text,$6::numeric,$7::text,$18,$19,
      CASE WHEN $15::int IS NULL THEN NULL ELSE $6::numeric*$15::int/10000 END,
      CASE WHEN $15::int IS NULL THEN NULL ELSE $7::text END
    FROM konektag.financial_transactions k JOIN konektag.api_payment_wallet_reservations r ON r.consumption_transaction_id=k.id
      CROSS JOIN konektag.financial_transactions m
    WHERE k.id=$8 AND k.currency='K' AND k.status='completed' AND m.id=$9 AND m.currency=$17::text AND m.status='completed'
      AND r.id=$10 AND r.payer_party_id=$2 AND r.amount=$5 AND r.lifecycle='captured'
    RETURNING *`,[input.operationKey,input.partyId,input.merchantId,input.legalEntityId,input.quantity,kValue.amount,kValue.currency,
      input.kTransactionId,input.monetaryTransactionId,input.reservationId,eligibility.eligible,eligibility.reference,input.paymentCountry,input.rail,cashbackRateBps,
      input.transactionAmountMinor,input.transactionCurrency,kValue.version,input.paymentValuationProofHash??null]);
  if(!row) throw new Error('POINTS_CONSUMPTION_PROOF_REQUIRED');
  if(row.cashback_amount!==null) {
    await db.query(`INSERT INTO konektag.fee_credits(consumption_id,party_id,currency,rate,initial_amount,remaining_amount,idempotency_key)
      VALUES($1,$2,$3,$4::int::numeric/10000,$5::numeric,$5::numeric,$6)`,
      [row.id,input.partyId,row.cashback_currency,cashbackRateBps,row.cashback_amount,`fee-credit:${row.id}`]);
  }
  // Payment records commercial source facts only. Merchant compensation (+1%),
  // its accounting owner and ERP projection belong to settlement, never payment.
  return row;
}

export async function feeCreditBalance(db:Database,partyId:string,currency:string):Promise<string> {
  const {rows:[r]}=await db.query(`SELECT COALESCE(sum(remaining_amount),0)::text AS amount
    FROM konektag.fee_credits WHERE party_id=$1 AND currency=$2 AND status='available'`,[partyId,currency]);
  return r.amount;
}

// Call inside the transaction which definitively bills these future fees. A
// rejected payment rolls this application back, including every allocation.
export async function applyFeeCreditToFees(db:Database,input:{partyId:string;operationKey:string;currency:string;feesDue:string}) {
  if(!/^\d+(\.\d{1,8})?$/.test(input.feesDue) || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('FEE_CREDIT_INVALID_FEE');
  const decimals=new Intl.NumberFormat('en',{style:'currency',currency:input.currency}).resolvedOptions().maximumFractionDigits!;
  const {rows:[result]}=await db.query('SELECT * FROM konektag.apply_fee_credit_to_fees($1,$2,$3,$4::numeric,$5)',
    [input.partyId,input.operationKey,input.currency,input.feesDue,decimals]);
  return result as {application_id:string;amount_applied:string;fees_remaining:string};
}

export async function reserveRechargeFeeCredit(db:Database,partyId:string,orderId:string,feesMinor:number):Promise<number> {
  if(!Number.isSafeInteger(feesMinor)||feesMinor<0) throw new Error('FEE_CREDIT_INVALID_FEE');
  const cents=BigInt(feesMinor), feeText=`${cents/100n}.${(cents%100n).toString().padStart(2,'0')}`;
  const {rows:[r]}=await db.query(`SELECT (amount_applied::numeric*100)::bigint::text AS applied_minor
    FROM konektag.reserve_fee_credit_quote($1,$2,'EUR',$3::numeric,2,$4)`,[partyId,`recharge-fees:${orderId}`,feeText,new Date(Date.now()+checkoutExpirationMinutes()*60_000)]);
  return Number(r.applied_minor);
}

// Called only as part of an approved full cancellation/refund transaction.
// Recovery of previously used credits is recorded, never deducted from K.
export async function cancelPointsBenefits(db:Database,consumptionId:string) {
  if((await db.query('SELECT id FROM konektag.points_merchant_refunds WHERE consumption_id=$1',[consumptionId])).rows.length) throw new Error('POINTS_USE_CANONICAL_REFUND');
  const {rows:[source]}=await db.query('SELECT party_id FROM konektag.points_merchant_consumptions WHERE id=$1',[consumptionId]);
  if(!source) throw new Error('POINTS_CONSUMPTION_NOT_FOUND');
  await lockPointsOwner(db,source.party_id);
  const {rows:[c]}=await db.query(`UPDATE konektag.points_merchant_consumptions SET status='cancelled',cancelled_at=now()
    WHERE id=$1 AND status='completed' RETURNING *`,[consumptionId]);
  if(!c) return;
  await db.query(`UPDATE konektag.merchant_settlements s SET points_bonus_review_required=true
    FROM konektag.merchant_settlement_sales link JOIN konektag.merchant_sales sale ON sale.id=link.sale_id
    WHERE s.id=link.settlement_id AND sale.transaction_id=$1`,[c.monetary_transaction_id]);
  await db.query(`UPDATE konektag.fee_credits f SET recovery_amount=COALESCE((SELECT sum(u.amount) FROM konektag.fee_credit_uses u
    JOIN konektag.fee_credit_applications a ON a.id=u.application_id WHERE u.fee_credit_id=f.id AND a.status='applied'),0),
    status=CASE WHEN EXISTS(SELECT 1 FROM konektag.fee_credit_uses u JOIN konektag.fee_credit_applications a ON a.id=u.application_id
      WHERE u.fee_credit_id=f.id AND a.status='applied' AND u.amount>0) THEN 'recovery_required' ELSE 'cancelled' END,
    remaining_amount=0,cancelled_at=now() WHERE consumption_id=$1`,[consumptionId]);
  const {rows:reversedBonuses}=await db.query(`UPDATE konektag.merchant_points_bonuses SET status='reversed',reversed_at=now(),reversal_projection_status='pending'
    WHERE consumption_id=$1 RETURNING id`,[consumptionId]);
  // Only an existing bonus (QR Pay / Link Pay) has a reversal to project.
  if(reversedBonuses.length) await db.query(`INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
    VALUES($1,'PointsMerchantConsumption',$1,'PointsMerchantBonusReversalRequested',1,jsonb_build_object('consumptionId',$1::uuid))`,[consumptionId]);
}

