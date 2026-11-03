import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../infrastructure/database/pool.ts';
import { apiPaymentCheckoutService } from '../../services/pay/api-payment-checkout-service.ts';
import {
  persistMobileMoneyReceipt,
  type MobileMoneyConfirmationInput,
  MobileMoneyConfirmationError,
} from './mobile-money-confirmation.ts';

interface ApiPaymentOrderRow {
  id: string;
  environment: string;
  state: string;
  payment_method: string | null;
  external_amount: number | string;
  currency: string;
  country: string | null;
}

export async function confirmApiPaymentMobileMoney(
  orderId: string,
  adminId: string,
  input: MobileMoneyConfirmationInput,
): Promise<{ orderId: string; idempotent: boolean }> {
  const client = await pool.connect();
  let shouldFinalize = false;
  let manualProviderReference: string | undefined;
  let manualProviderEventId: string | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL lock_timeout = 5000');
    const { rows } = await client.query<ApiPaymentOrderRow>(
       `SELECT o.id, o.environment, o.state, o.payment_method, o.external_amount, o.currency,
               NULLIF(upper(COALESCE(le.country_code, mp.country)), '') AS country
        FROM konektag.api_payment_orders o
        LEFT JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id AND mp.deleted_at IS NULL
        LEFT JOIN konektag.legal_entities le ON le.id = o.settlement_legal_entity_id AND le.deleted_at IS NULL
       WHERE o.id = $1
       FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (!order) throw new MobileMoneyConfirmationError('API payment order not found', 404);
    if (order.environment !== 'live') throw new MobileMoneyConfirmationError('Only live API payments can be confirmed', 409);
    if (Number(order.external_amount) !== input.amount || String(order.currency).toUpperCase() !== input.currency) {
      throw new MobileMoneyConfirmationError('Receipt amount and currency must exactly match the outstanding API payment', 409);
    }
    // Merchantless NETWORK orders use their frozen settlement entity country.
    if (!order.country || !/^[A-Z]{2}$/.test(order.country)) {
      throw new MobileMoneyConfirmationError('API payment merchant country is unavailable', 409);
    }
    if (order.country !== input.country) throw new MobileMoneyConfirmationError('Receipt country does not match the merchant country', 409);

    if (order.state === 'paid') {
      const { rows: receiptRows } = await client.query<{ id: string }>(
        `SELECT id FROM konektag.mobile_money_receipts WHERE source_type = 'api_payment' AND source_id = $1`,
        [order.id],
      );
      if (!receiptRows[0]) throw new MobileMoneyConfirmationError('API payment was not confirmed by this Mobile Money queue', 409);
      const receipt = await persistMobileMoneyReceipt(client, 'api_payment', order.id, adminId, input);
      if (!receipt.existing) throw new MobileMoneyConfirmationError('API payment receipt conflict', 409);
      await client.query('COMMIT');
      return { orderId, idempotent: true };
    }
    if (order.state !== 'awaiting_mobile_money' || order.payment_method !== 'mobile_money') {
      throw new MobileMoneyConfirmationError('API payment is not awaiting Mobile Money confirmation', 409);
    }
    const receipt = await persistMobileMoneyReceipt(client, 'api_payment', order.id, adminId, input);
    await client.query(
      `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, 'API_PAYMENT_MOBILE_MONEY_CONFIRM', 'api_payment', $2, $3, $4)`,
      [adminId, order.id, input.note || `Mobile Money receipt ${input.providerReference}`,
        JSON.stringify({ receiptId: receipt.id, provider: input.provider, country: input.country,
          operator: input.operator, providerReference: input.providerReference, amount: input.amount,
          currency: input.currency, receivedAt: input.receivedAt, maskedSender: input.maskedSender })],
    );
    manualProviderReference = input.providerReference;
    const expectedMinor = Math.round(Number(order.external_amount) * (['XOF','XAF','XPF','JPY','KRW','VND','BIF','CLP','DJF','GNF','KMF','MGA','PYG','RWF','UGX','VUV'].includes(order.currency) ? 1 : 100));
    const attemptId = randomUUID();
    await client.query(
      `INSERT INTO konektag.payment_provider_attempts
       (id,source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency,state,metadata)
       VALUES($1,'api_payment',$2,$2,'manual',$3,$4,$5,'succeeded',$6)
       ON CONFLICT(provider,provider_reference) DO NOTHING`,
      [attemptId,order.id,input.providerReference,expectedMinor,order.currency,JSON.stringify({receiptId:receipt.id,checker:'manual-review'})],
    );
    const { rows:[attempt] } = await client.query<{id:string}>(
      `SELECT id FROM konektag.payment_provider_attempts WHERE provider='manual' AND provider_reference=$1 AND source_id::text=$2::text`,
      [input.providerReference,order.id],
    );
    if (!attempt) throw new MobileMoneyConfirmationError('Manual payment proof conflicts with another operation',409);
    const eventKey = `manual:${order.id}:${input.providerReference}`;
    const payloadHash = createHash('sha256').update(JSON.stringify({
      receiptId:receipt.id,provider:input.provider,reference:input.providerReference,amount:input.amount,currency:input.currency,receivedAt:input.receivedAt,
    })).digest('hex');
    const { rows:[providerEvent] } = await client.query<{id:string}>(
      `INSERT INTO konektag.payment_provider_events(provider,provider_event_id,attempt_id,event_type,payload_hash,processed_at)
       VALUES('manual',$1,$2,'manual_payment.approved',$3,NULL)
       ON CONFLICT(provider,provider_event_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id
       RETURNING id`,
      [eventKey,attempt.id,payloadHash],
    );
    manualProviderEventId = providerEvent.id;
    await client.query('COMMIT');
    shouldFinalize = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (shouldFinalize) {
    // This established method posts accounting, persists final state, emits SSE, and queues the webhook.
    await apiPaymentCheckoutService.markFinalAndDispatch(orderId, 'mobile_money', manualProviderReference, manualProviderEventId);
    if (manualProviderEventId) await pool.query(`UPDATE konektag.payment_provider_events SET processed_at=now() WHERE id=$1`,[manualProviderEventId]);
  }
  return { orderId, idempotent: false };
}
