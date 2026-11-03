import type { PoolClient } from 'pg';
import { lockPointsOwner } from './points-reservation-service.ts';
import { pointsBenefitEligibility } from './points-benefits-service.ts';
import { valueConsumedPointsK } from '../points-k-valuation-service.ts';
type Database = Pick<PoolClient, 'query'>;

// Link-only source proof; existing cashback eligibility and calculation are preserved.
export async function recordLinkKConsumption(db:Database,input:{
  operationKey:string;partyId:string;merchantId:string;quantity:number;
  transactionAmountMinor:number;transactionCurrency:string;paymentValuationProofHash?:string|null;
  kOperationId:string;reservationId:string;
  rail:string;paymentCountry:string|null;
}) {
  await lockPointsOwner(db,input.partyId);
  const {rows:[existing]}=await db.query('SELECT * FROM konektag.points_merchant_consumptions WHERE operation_key=$1',[input.operationKey]);
  if(existing) {
    if(existing.party_id!==input.partyId || existing.k_operation_id!==input.kOperationId || existing.merchant_profile_id!==input.merchantId)
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
    (operation_key,party_id,merchant_profile_id,quantity,merchant_value,currency,
     k_operation_id,reservation_id,eligible,eligibility_reference,payment_country,payment_rail,cashback_rate_bps,
     value_basis_version,transaction_amount_minor,transaction_currency,k_value_amount,k_value_currency,k_valuation_version,
     payment_valuation_proof_hash,cashback_amount,cashback_currency)
    SELECT $1,$2,$3,$4,$5::numeric,$6::text,k.id,r.id,$9,$10,$11,$12,$13::int,
      2,$14,$15::text,$5::numeric,$6::text,$16,$17,
      CASE WHEN $13::int IS NULL THEN NULL ELSE $5::numeric*$13::int/10000 END,
      CASE WHEN $13::int IS NULL THEN NULL ELSE $6::text END
    FROM konektag.k_operations k JOIN konektag.api_payment_wallet_reservations r ON r.k_operation_id=k.id
    WHERE k.id=$7 AND k.operation_type='merchant_consumption' AND k.status='completed'
      AND r.id=$8 AND r.payer_party_id=$2 AND r.amount=$4 AND r.lifecycle='captured'
    RETURNING *`,[input.operationKey,input.partyId,input.merchantId,input.quantity,kValue.amount,kValue.currency,
      input.kOperationId,input.reservationId,eligibility.eligible,eligibility.reference,input.paymentCountry,input.rail,cashbackRateBps,
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
