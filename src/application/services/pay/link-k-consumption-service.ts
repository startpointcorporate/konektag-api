import type { PoolClient } from 'pg';
import { resolvePointsOwner, pointsBalance } from './points-wallet-service.ts';
import { lockPointsOwner, reservePoints } from './points-reservation-service.ts';
import { requireFinancialAccountActive } from '../wallet-integrity-service.ts';
import { MerchantKybService } from '../merchant-kyb-service.ts';
import { checkUserKycVerified } from '../user-kyc-gate-service.ts';
import { recordLinkKConsumption } from './link-k-consumption-facts.ts';

type Database = Pick<PoolClient, 'query'>;

/** Caller owns the transaction. The completed K operation and its capture commit together. */
export async function consumeReservedLinkPoints(db: Database, input: {
  partyId: string; reservationId: string; operationKey: string; quantity: number;
}): Promise<string> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || !input.operationKey.trim()) throw new Error('INVALID_POINTS_QUANTITY');
  await lockPointsOwner(db, input.partyId);
  const { rows: [hold] } = await db.query(`SELECT *, expires_at<=statement_timestamp() AS expired
    FROM konektag.api_payment_wallet_reservations WHERE id=$1 AND payer_party_id=$2 AND currency='K' FOR UPDATE`,
    [input.reservationId, input.partyId]);
  if (!hold || Number(hold.amount) !== input.quantity) throw new Error('POINTS_RESERVATION_MISMATCH');
  if (hold.lifecycle === 'captured') {
    const { rows: [previous] } = await db.query(`SELECT id FROM konektag.k_operations
      WHERE id=$1 AND operation_key=$2 AND party_id=$3 AND quantity=$4 AND reservation_id=$5
        AND status='completed' AND operation_type='merchant_consumption'`,
      [hold.k_operation_id, input.operationKey, input.partyId, input.quantity, hold.id]);
    if (!previous) throw new Error('POINTS_CONSUMPTION_REPLAY_CONFLICT');
    return previous.id;
  }
  if (hold.lifecycle !== 'active' || hold.expired) throw new Error('POINTS_RESERVATION_NOT_ACTIVE');
  await requireFinancialAccountActive(db, input.partyId); // Preserve wallet integrity holds.
  const balance = await pointsBalance(input.partyId, db);
  if (balance.balance < input.quantity || balance.available < 0) throw new Error('POINTS_INSUFFICIENT');
  const { rows: [operation] } = await db.query(`INSERT INTO konektag.k_operations
    (operation_key,operation_type,party_id,quantity,reservation_id)
    VALUES($1,'merchant_consumption',$2,$3,$4) RETURNING id`,
    [input.operationKey, input.partyId, input.quantity, hold.id]);
  for (const [account, side, party] of [['1000', 'debit', input.partyId], ['K_ISSUANCE', 'credit', null]]) {
    await db.query(`INSERT INTO konektag.ledger_entries
      (k_operation_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,value_date)
      VALUES($1,$2,$3,$3,$4,$5,'K','consumption',$6,CURRENT_DATE)`,
      [operation.id, account, side, party, input.quantity, hold.id]);
  }
  await db.query("UPDATE konektag.k_operations SET status='completed',completed_at=now() WHERE id=$1", [operation.id]);
  // The reservation trigger validates the completed K operation, owner, quantity and source hold.
  await db.query(`UPDATE konektag.api_payment_wallet_reservations SET lifecycle='captured',k_operation_id=$2,
    captured_at=now(),updated_at=now(),version=version+1 WHERE id=$1`, [hold.id, operation.id]);
  return operation.id;
}

export interface LinkKConsumptionCommand {
  idempotencyKey: string; userId: string; merchantProfileId: string;
  amount: number; currency: string; quantityK: number; quantityValuationProofHash: string;
  merchantSaleRef: string; rail: 'payment_link';
}

/** Only Link Pay uses this path. Sale facts and K extinction share the caller's transaction. */
export async function consumeLinkAtMerchant(cmd: LinkKConsumptionCommand, client: PoolClient) {
  if (!Number.isSafeInteger(cmd.quantityK) || cmd.quantityK <= 0) throw new Error('INVALID_POINTS_QUANTITY');
  if (!Number.isSafeInteger(cmd.amount) || cmd.amount <= 0) throw new Error('INVALID_COMMERCIAL_AMOUNT');
  if (cmd.rail !== 'payment_link') throw new Error('LINK_K_ONLY');
  const partyId = await resolvePointsOwner(client, cmd.userId);
  await lockPointsOwner(client, partyId);
  const { rows: [previous] } = await client.query(`SELECT c.*,s.id AS sale_id,s.sale_ref FROM konektag.points_merchant_consumptions c
    LEFT JOIN konektag.merchant_sales s ON s.k_operation_id=c.k_operation_id WHERE c.operation_key=$1`, [cmd.idempotencyKey]);
  if (previous) {
    if (!previous.k_operation_id || !previous.sale_id || previous.party_id !== partyId || previous.merchant_profile_id !== cmd.merchantProfileId
      || Number(previous.quantity) !== cmd.quantityK || Number(previous.transaction_amount_minor) !== cmd.amount
      || previous.transaction_currency !== cmd.currency || previous.payment_valuation_proof_hash !== cmd.quantityValuationProofHash
      || previous.sale_ref !== cmd.merchantSaleRef) throw new Error('POINTS_CONSUMPTION_REPLAY_CONFLICT');
    return { success: true as const, kOperationId: previous.k_operation_id as string, merchantSaleId: previous.sale_id as string };
  }
  const kyc = await checkUserKycVerified(client, cmd.userId);
  if (!kyc.verified) throw new Error('USER_KYC_REQUIRED');
  const kyb = await new MerchantKybService(client).requireMerchantApproved(cmd.merchantProfileId);
  if (!kyb.approved) throw new Error(`MERCHANT_KYB_REQUIRED: ${kyb.reason}`);
  const { rows: [merchant] } = await client.query('SELECT country,user_id FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL', [cmd.merchantProfileId]);
  if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
  if (merchant.user_id === cmd.userId) throw new Error('SELF_PAYMENT_FORBIDDEN');
  const hold = await reservePoints(client, { partyId, operationKey: cmd.idempotencyKey, quantity: cmd.quantityK, expiresAt: new Date(Date.now() + 30 * 60_000) });
  const kOperationId = await consumeReservedLinkPoints(client, { partyId, reservationId: hold.id,
    operationKey: `points-consumption:${hold.id}`, quantity: cmd.quantityK });
  await recordLinkKConsumption(client, { operationKey: cmd.idempotencyKey, partyId, merchantId: cmd.merchantProfileId,
    quantity: cmd.quantityK, transactionAmountMinor: cmd.amount, transactionCurrency: cmd.currency,
    paymentValuationProofHash: cmd.quantityValuationProofHash, kOperationId, reservationId: hold.id,
    rail: 'payment_link', paymentCountry: merchant.country });
  const { rows: [sale] } = await client.query(`INSERT INTO konektag.merchant_sales
    (sale_ref,merchant_profile_id,k_operation_id,gross_amount,net_amount,commission_amount,commission_rate,currency,status)
    VALUES($1,$2,$3,$4,$4,0,0,$5,'CREATED') RETURNING id`,
    [cmd.merchantSaleRef, cmd.merchantProfileId, kOperationId, cmd.amount, cmd.currency]);
  return { success: true as const, kOperationId, merchantSaleId: sale.id as string };
}
