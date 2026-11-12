import { randomUUID } from 'node:crypto';
import { assertPawaPayFinancialOperation } from '../../../infrastructure/adapters/pawapay-sandbox-policy.ts';
import type Stripe from 'stripe';
import pool from '../../../infrastructure/database/pool.ts';
import { fromPawaPayAmount, type PawaPayDeposit } from '../../../infrastructure/adapters/pawapay-client.ts';

export type PaymentProviderSourceType = 'recharge' | 'qr_pay' | 'transfer' | 'api_payment' | 'payment_link';

interface ProviderAttemptRow {
  id: string;
  source_type: PaymentProviderSourceType;
  source_id: string;
  operation_id: string;
  provider: string;
  provider_reference: string;
  expected_amount: number | string;
  expected_currency: string;
}

interface ProviderEventRow {
  id: string;
  processed_at: string | null;
  failed_at: string | null;
}

export interface StripeCardDetails {
  country?: string;
  brand?: string;
  funding?: string;
  bin?: string;
}

export interface StripeApiCheckoutAttemptInput {
  orderId: string;
  paymentIntent: Pick<Stripe.PaymentIntent, 'id' | 'amount' | 'currency' | 'status'> & {
    payment_method_details?: unknown;
  };
  metadata?: Record<string, unknown>;
}

export interface StripeRechargeAttemptInput {
  rechargeName: string;
  paymentIntent: Pick<Stripe.PaymentIntent, 'id' | 'amount' | 'currency' | 'status'> & {
    payment_method_details?: unknown;
  };
}

export interface StripeEventInput {
  id: string;
  type: string;
  payloadHash: string;
  paymentIntent?: Pick<Stripe.PaymentIntent, 'id' | 'amount' | 'currency' | 'status' | 'metadata'> & {
    payment_method_details?: unknown;
  };
}

export type StripeEventConsumption =
  | { outcome: 'deduplicated' | 'ignored' | 'rejected' }
  | { outcome: 'ready_to_settle'; eventId: string; sourceType: PaymentProviderSourceType; sourceId: string };
export type PawaPayEventConsumption =
  | { outcome: 'deduplicated' | 'rejected' }
  | { outcome: 'processing' | 'failed'; sourceId: string }
  | { outcome: 'ready_to_settle'; eventId: string; sourceId: string };

export class PaymentProviderAttemptValidationError extends Error {}
export class PaymentProviderAttemptConflictError extends Error {}

const PROHIBITED_METADATA_KEY = /pan|cvc|expiry|expiration|last4|client.?secret|raw.*payload|stripe.*payload/i;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cardState(status: string): 'pending' | 'processing' | 'succeeded' | 'failed' {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'failed';
  if (status === 'processing' || status === 'requires_action') return 'processing';
  return 'pending';
}

function safeMetadataValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(safeMetadataValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
      if (PROHIBITED_METADATA_KEY.test(key)) {
        throw new PaymentProviderAttemptValidationError(`Unsafe provider metadata field: ${key}`);
      }
      return [key, safeMetadataValue(nestedValue)];
    }));
  }
  throw new PaymentProviderAttemptValidationError('Provider metadata must be safe JSON data');
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return safeMetadataValue(metadata) as Record<string, unknown>;
}

export function validateProviderCardBin(bin: string | undefined): string | undefined {
  if (bin === undefined) return undefined;
  if (!/^\d{8}$/.test(bin)) {
    throw new PaymentProviderAttemptValidationError('Provider card BIN must be exactly eight digits');
  }
  return bin;
}

// Stripe does not normally expose a BIN. If it ever does, accept only an explicit
// eight-digit provider field; never derive digits from any other card attribute.
export function stripeSafeCardDetails(paymentMethodDetails: unknown): StripeCardDetails {
  if (!paymentMethodDetails || typeof paymentMethodDetails !== 'object') return {};
  const card = (paymentMethodDetails as { card?: unknown }).card;
  if (!card || typeof card !== 'object') return {};
  const values = card as Record<string, unknown>;
  const bin = typeof values.bin === 'string' ? validateProviderCardBin(values.bin) : undefined;
  return {
    country: nonEmptyString(values.country),
    brand: nonEmptyString(values.brand),
    funding: nonEmptyString(values.funding),
    ...(bin ? { bin } : {}),
  };
}

function assertStripeIntent(paymentIntent: { id: string; amount: number; currency: string }): void {
  if (!paymentIntent.id.startsWith('pi_')) throw new PaymentProviderAttemptValidationError('Invalid Stripe PaymentIntent ID');
  if (!Number.isSafeInteger(paymentIntent.amount) || paymentIntent.amount <= 0) {
    throw new PaymentProviderAttemptValidationError('Invalid Stripe PaymentIntent amount');
  }
  if (!/^[A-Za-z]{3}$/.test(paymentIntent.currency)) {
    throw new PaymentProviderAttemptValidationError('Invalid Stripe PaymentIntent currency');
  }
}

/** Network follow-up of the Points K recharge an attempt belongs to (no-op for other attempts). */
async function enqueueRechargeOperation(db: Pick<import('pg').PoolClient, 'query'>, input: Parameters<typeof import('../../network-operations/network-operations.ts').enqueueRechargeOperation>[1]) {
  const operations = await import('../../network-operations/network-operations.ts');
  return operations.enqueueRechargeOperation(db, input);
}

export const paymentProviderAttemptService = {
  async expireStaleApiPaymentAttempts(orderId?: string): Promise<number> {
    const result = await pool.query(
      `UPDATE konektag.payment_provider_attempts
       SET state='expired',updated_at=now(),version=version+1
       WHERE source_type='api_payment' AND state IN ('pending','processing')
         AND expires_at IS NOT NULL AND expires_at<=now()
         AND COALESCE(metadata->>'depositRequested','false')<>'true'
         AND NOT EXISTS (SELECT 1 FROM konektag.api_payment_orders o
           WHERE o.id::text=payment_provider_attempts.source_id
             AND o.order_metadata ? 'erpnextPointsK' AND payment_provider_attempts.provider='stripe')
         AND ($1::uuid IS NULL OR source_id=$1::text)`,
      [orderId ?? null],
    );
    return result.rowCount ?? 0;
  },
  async createOrGetPawaPayApiCheckoutAttempt(input: { orderId: string; amount: number; currency: string; providerConfigurationKey: string | null }): Promise<string> {
    assertPawaPayFinancialOperation(input.providerConfigurationKey);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise attempt creation on the order: FOR UPDATE on zero attempt rows locks nothing.
      await client.query(`SELECT 1 FROM konektag.api_payment_orders WHERE id=$1::uuid FOR UPDATE`, [input.orderId]);
      const existing = await client.query<{ provider_reference:string; metadata:any }>(
        `SELECT provider_reference,metadata FROM konektag.payment_provider_attempts
         WHERE provider='pawapay' AND source_type='api_payment' AND source_id=$1
           AND state IN ('pending','processing') AND (expires_at IS NULL OR expires_at>now() OR metadata->>'depositRequested'='true')
         FOR UPDATE`, [input.orderId]);
      // A direct deposit already prompted the payer's phone: never reuse its depositId on a Payment Page.
      if (existing.rows[0]?.metadata?.directDeposit) throw new PaymentProviderAttemptConflictError('A payment attempt is still active');
      if (existing.rows[0]) { await client.query('COMMIT'); return existing.rows[0].provider_reference; }
      const depositId = randomUUID();
      // Payment Page URL is valid for 15 minutes according to PawaPay. The
      // attempt exists before the customer pays, but metadata records that no
      // deposit has yet been observed at PawaPay.
      await client.query(
        `INSERT INTO konektag.payment_provider_attempts
         (source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency,state,metadata,expires_at)
         VALUES('api_payment',$1,$1,'pawapay',$2,$3,$4,'pending',$5::jsonb,now()+interval '15 minutes')`,
        [input.orderId,depositId,input.amount,input.currency.toUpperCase(),
         JSON.stringify({providerConfigurationKey:input.providerConfigurationKey,paymentPageCreated:true,depositObserved:false})]);
      await client.query('COMMIT');
      return depositId;
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  },
  /**
   * Direct v2 deposit for one payer phone and operator. An active attempt is reused
   * only for the same phone/operator (same depositId, so pawaPay ignores the retry);
   * any other active attempt, including a Payment Page, locks the checkout.
   */
  async createOrGetPawaPayDirectDepositAttempt(input: { orderId: string; amount: number; currency: string; providerConfigurationKey: string | null; provider: string; phoneNumberHash: string }): Promise<{ depositId: string; created: boolean }> {
    assertPawaPayFinancialOperation(input.providerConfigurationKey);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise attempt creation on the order: FOR UPDATE on zero attempt rows locks nothing.
      await client.query(`SELECT 1 FROM konektag.api_payment_orders WHERE id=$1::uuid FOR UPDATE`, [input.orderId]);
      const existing = await client.query<{ provider: string; provider_reference: string; metadata: any }>(
        `SELECT provider,provider_reference,metadata FROM konektag.payment_provider_attempts
         WHERE source_type='api_payment' AND source_id=$1
           AND state IN ('pending','processing') AND (expires_at IS NULL OR expires_at>now() OR metadata->>'depositRequested'='true')
         FOR UPDATE`, [input.orderId]);
      if (existing.rows.length) {
        const direct = existing.rows.length === 1 && existing.rows[0].provider === 'pawapay' ? existing.rows[0].metadata?.directDeposit : null;
        if (!direct || direct.provider !== input.provider || direct.phoneNumberHash !== input.phoneNumberHash) {
          throw new PaymentProviderAttemptConflictError('A payment attempt is still active');
        }
        await client.query('COMMIT');
        return { depositId: existing.rows[0].provider_reference, created: false };
      }
      const depositId = randomUUID();
      // The operator prompt is short-lived; until pawaPay accepts the deposit the attempt expires on its own.
      await client.query(
        `INSERT INTO konektag.payment_provider_attempts
         (source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency,state,metadata,expires_at)
         VALUES('api_payment',$1,$1,'pawapay',$2,$3,$4,'pending',$5::jsonb,now()+interval '15 minutes')`,
        [input.orderId,depositId,input.amount,input.currency.toUpperCase(),
         JSON.stringify({providerConfigurationKey:input.providerConfigurationKey,depositObserved:false,
           directDeposit:{provider:input.provider,phoneNumberHash:input.phoneNumberHash}})]);
      await client.query('COMMIT');
      return { depositId, created: true };
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  },
  /**
   * Marks that the deposit is about to be sent to pawaPay. Returns false when the attempt was
   * released or expired meanwhile: the caller must then not contact pawaPay with this depositId.
   */
  async claimPawaPayDepositRequest(depositId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE konektag.payment_provider_attempts
       SET metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('depositRequested',true), expires_at=NULL,
           updated_at=now(),version=version+1
       WHERE provider='pawapay' AND provider_reference=$1 AND state IN ('pending','processing')
         AND (expires_at IS NULL OR expires_at>now() OR metadata->>'depositRequested'='true')`,[depositId]);
    return (result.rowCount ?? 0) > 0;
  },
  /**
   * Compensation when the checkout could not be locked: releases the attempt only while no
   * deposit request was ever sent to pawaPay, so a concurrent retry that did send it is kept.
   */
  async releasePawaPayDirectDepositAttempt(depositId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE konektag.payment_provider_attempts
       SET state='cancelled',updated_at=now(),version=version+1
       WHERE provider='pawapay' AND provider_reference=$1 AND state='pending'
         AND COALESCE((metadata->>'depositRequested')::boolean,false)=false`,[depositId]);
    return (result.rowCount ?? 0) > 0;
  },
  /** pawaPay synchronously REJECTED the deposit: it does not exist there and no callback will follow. */
  async markPawaPayDepositRejected(depositId: string, failureCode: string | null): Promise<void> {
    await pool.query(
      `UPDATE konektag.payment_provider_attempts
       SET state='failed',metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('rejectedFailureCode',$2::text),
           updated_at=now(),version=version+1
       WHERE provider='pawapay' AND provider_reference=$1 AND state IN ('pending','processing')`,[depositId,failureCode]);
  },
  async markPawaPayDepositObserved(depositId:string): Promise<void> {
    await pool.query(
      `UPDATE konektag.payment_provider_attempts
       SET metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('depositObserved',true),
           expires_at=NULL,updated_at=now(),version=version+1
       WHERE provider='pawapay' AND provider_reference=$1`,[depositId]);
  },
  async hasActiveApiPaymentAttempt(orderId: string): Promise<boolean> {
    await this.expireStaleApiPaymentAttempts(orderId);
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM konektag.payment_provider_attempts
       WHERE source_type='api_payment' AND source_id=$1
         AND state IN ('pending','processing') AND (expires_at IS NULL OR expires_at>now() OR metadata->>'depositRequested'='true')) AS present`,
      [orderId],
    );
    return rows[0]?.present === true;
  },
  async getPawaPayConfigurationKey(reference: string): Promise<string | null> {
    const { rows } = await pool.query<{ metadata: { providerConfigurationKey?: unknown; checkoutId?: unknown } }>(
      `SELECT metadata FROM konektag.payment_provider_attempts
       WHERE provider='pawapay'
         AND (provider_reference=$1 OR metadata->>'checkoutId'=$1)
       ORDER BY updated_at DESC LIMIT 1`, [reference]);
    const key = rows[0]?.metadata?.providerConfigurationKey;
    return typeof key === 'string' ? key : null;
  },
  async consumePawaPayDeposit(deposit: PawaPayDeposit, payloadHash: string): Promise<PawaPayEventConsumption> {
    assertPawaPayFinancialOperation(await this.getPawaPayConfigurationKey(deposit.depositId));
    const amount = fromPawaPayAmount(deposit.currency.toUpperCase(), deposit.amount); const eventKey = `pawapay:deposit:${deposit.depositId}:${deposit.status}`; const client = await pool.connect();
    try { await client.query('BEGIN'); const inserted = await client.query<ProviderEventRow>(`INSERT INTO konektag.payment_provider_events(provider,provider_event_id,event_type,payload_hash) VALUES('pawapay',$1,$2,$3) ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id,processed_at,failed_at`, [eventKey, `deposit.${deposit.status.toLowerCase()}`, payloadHash]); let event = inserted.rows[0]; if (!event) { const row = await client.query<ProviderEventRow>(`SELECT id,processed_at,failed_at FROM konektag.payment_provider_events WHERE provider='pawapay' AND provider_event_id=$1 FOR UPDATE`, [eventKey]); event = row.rows[0]; if (!event || event.processed_at) { await client.query('COMMIT'); return { outcome: 'deduplicated' }; }
      if (event.failed_at) {
        const retryable = await client.query<{ error_code:string|null }>(
          `SELECT error_code FROM konektag.payment_provider_events WHERE id=$1 FOR UPDATE`, [event.id]);
        if (retryable.rows[0]?.error_code !== 'attempt_mismatch') {
          await client.query('COMMIT'); return { outcome: 'deduplicated' };
        }
        // A deterministic attempt_mismatch can be retried safely after the
        // authoritative attempt/order data or validation logic has been fixed.
        // Reuse the same provider event; never create a duplicate financial event.
        await client.query(
          `UPDATE konektag.payment_provider_events
           SET failed_at=NULL,error_code=NULL WHERE id=$1`, [event.id]);
        event.failed_at = null;
      } } const attempts = await client.query<ProviderAttemptRow & { state: string }>(`SELECT id,source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency,state FROM konektag.payment_provider_attempts WHERE provider='pawapay' AND provider_reference=$1 FOR UPDATE`, [deposit.depositId]); const attempt = attempts.rows[0]; if (!attempt || attempt.source_type !== 'api_payment' || Number(attempt.expected_amount) !== amount || attempt.expected_currency !== deposit.currency.toUpperCase()) { await client.query(`UPDATE konektag.payment_provider_events SET attempt_id=$2,failed_at=now(),error_code='attempt_mismatch' WHERE id=$1`, [event.id, attempt?.id ?? null]); await client.query('COMMIT'); return { outcome: 'rejected' }; } await client.query(`UPDATE konektag.payment_provider_events SET attempt_id=$2 WHERE id=$1`, [event.id, attempt.id]); if (deposit.status === 'FAILED' && attempt.state === 'succeeded') { await client.query(`UPDATE konektag.payment_provider_events SET failed_at=now(),error_code='invalid_state_regression' WHERE id=$1`, [event.id]); await client.query('COMMIT'); return { outcome: 'rejected' }; } const state = deposit.status === 'COMPLETED' ? 'succeeded' : deposit.status === 'FAILED' ? 'failed' : 'processing'; await client.query(`UPDATE konektag.payment_provider_attempts SET state=$2,updated_at=now(),version=version+1 WHERE id=$1`, [attempt.id, state]);
      // Same transaction: the Network operation follows the attempt (webhook and reconciliation alike).
      await enqueueRechargeOperation(client, { provider: 'pawapay', providerReference: deposit.depositId,
        status: state === 'succeeded' ? 'paid' : state === 'failed' ? 'failed' : 'pending',
        failureReason: typeof deposit.failureReason === 'string' ? deposit.failureReason : (deposit.failureReason as any)?.failureCode ?? null }); if (deposit.status !== 'COMPLETED') await client.query(`UPDATE konektag.payment_provider_events SET processed_at=now() WHERE id=$1`, [event.id]); await client.query('COMMIT'); return deposit.status === 'COMPLETED'
        ? { outcome: 'ready_to_settle', eventId: event.id, sourceId: attempt.source_id }
        : { outcome: deposit.status === 'FAILED' ? 'failed' : 'processing', sourceId: attempt.source_id }; } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  },
  /** The provider accepted the request and gave its reference: the Network sees the recharge, pending. */
  async recordRechargeAccepted(provider: 'stripe' | 'pawapay', providerReference: string): Promise<void> {
    if (provider === 'pawapay') assertPawaPayFinancialOperation(await this.getPawaPayConfigurationKey(providerReference));
    try { await enqueueRechargeOperation(pool, { provider, providerReference, status: 'pending' }); }
    catch (error) { console.error('[network-operations] pending recharge not queued', { provider, providerReference, error: (error as Error).message }); }
  },
  async markPawaPayEventProcessed(eventId: string): Promise<void> { await pool.query(`UPDATE konektag.payment_provider_events SET processed_at=now(),error_code=NULL WHERE id=$1 AND processed_at IS NULL`, [eventId]); },
  async createOrUpdateStripeApiCheckoutAttempt(input: StripeApiCheckoutAttemptInput): Promise<void> {
    assertStripeIntent(input.paymentIntent);
    const card = stripeSafeCardDetails(input.paymentIntent.payment_method_details);
    const metadata = safeMetadata(input.metadata);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO konektag.payment_provider_attempts
        (source_type, source_id, operation_id, provider, provider_reference,
         expected_amount, expected_currency, provider_country, provider_card_brand,
         provider_card_funding, provider_card_bin, state, metadata, expires_at)
       VALUES ('api_payment', $1, $1, 'stripe', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now() + interval '30 minutes')
       ON CONFLICT (provider, provider_reference) DO UPDATE
       SET provider_country = COALESCE(EXCLUDED.provider_country, konektag.payment_provider_attempts.provider_country),
           provider_card_brand = COALESCE(EXCLUDED.provider_card_brand, konektag.payment_provider_attempts.provider_card_brand),
           provider_card_funding = COALESCE(EXCLUDED.provider_card_funding, konektag.payment_provider_attempts.provider_card_funding),
           provider_card_bin = COALESCE(EXCLUDED.provider_card_bin, konektag.payment_provider_attempts.provider_card_bin),
           state = EXCLUDED.state,
           metadata = EXCLUDED.metadata,
           updated_at = now(), version = konektag.payment_provider_attempts.version + 1
       WHERE konektag.payment_provider_attempts.source_type = 'api_payment'
         AND konektag.payment_provider_attempts.source_id = EXCLUDED.source_id
         AND konektag.payment_provider_attempts.operation_id = EXCLUDED.operation_id
         AND konektag.payment_provider_attempts.expected_amount = EXCLUDED.expected_amount
         AND konektag.payment_provider_attempts.expected_currency = EXCLUDED.expected_currency
       RETURNING id`,
      [
        input.orderId,
        input.paymentIntent.id,
        input.paymentIntent.amount,
        input.paymentIntent.currency.toUpperCase(),
        card.country ?? null,
        card.brand ?? null,
        card.funding ?? null,
        card.bin ?? null,
        cardState(input.paymentIntent.status),
        JSON.stringify(metadata),
      ],
    );
    if (!rows[0]) throw new PaymentProviderAttemptValidationError('Stripe PaymentIntent is already associated with another payment');
  },

  async createStripeRechargeAttempt(input: StripeRechargeAttemptInput): Promise<void> {
    assertStripeIntent(input.paymentIntent);
    const card = stripeSafeCardDetails(input.paymentIntent.payment_method_details);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO konektag.payment_provider_attempts
        (source_type, source_id, operation_id, provider, provider_reference,
         expected_amount, expected_currency, provider_country, provider_card_brand,
         provider_card_funding, provider_card_bin, state)
       VALUES ('recharge', $1, $1, 'stripe', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider, provider_reference) DO UPDATE
       SET provider_country = COALESCE(EXCLUDED.provider_country, konektag.payment_provider_attempts.provider_country),
           provider_card_brand = COALESCE(EXCLUDED.provider_card_brand, konektag.payment_provider_attempts.provider_card_brand),
           provider_card_funding = COALESCE(EXCLUDED.provider_card_funding, konektag.payment_provider_attempts.provider_card_funding),
           provider_card_bin = COALESCE(EXCLUDED.provider_card_bin, konektag.payment_provider_attempts.provider_card_bin),
           state = EXCLUDED.state,
           updated_at = now(), version = konektag.payment_provider_attempts.version + 1
       WHERE konektag.payment_provider_attempts.source_type = 'recharge'
         AND konektag.payment_provider_attempts.source_id = EXCLUDED.source_id
         AND konektag.payment_provider_attempts.operation_id = EXCLUDED.operation_id
         AND konektag.payment_provider_attempts.expected_amount = EXCLUDED.expected_amount
         AND konektag.payment_provider_attempts.expected_currency = EXCLUDED.expected_currency
       RETURNING id`,
      [
        input.rechargeName,
        input.paymentIntent.id,
        input.paymentIntent.amount,
        input.paymentIntent.currency.toUpperCase(),
        card.country ?? null,
        card.brand ?? null,
        card.funding ?? null,
        card.bin ?? null,
        cardState(input.paymentIntent.status),
      ],
    );
    if (!rows[0]) throw new PaymentProviderAttemptValidationError('Stripe PaymentIntent is already associated with another payment');
  },

  async consumeStripeEvent(input: StripeEventInput): Promise<StripeEventConsumption> {
    if (!input.id || !input.type || !/^[0-9a-f]{64}$/.test(input.payloadHash)) {
      throw new PaymentProviderAttemptValidationError('Invalid Stripe event');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: inserted } = await client.query<ProviderEventRow>(
        `INSERT INTO konektag.payment_provider_events (provider, provider_event_id, event_type, payload_hash)
         VALUES ('stripe', $1, $2, $3)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id, processed_at, failed_at`,
        [input.id, input.type, input.payloadHash],
      );
      let event = inserted[0];
      if (!event) {
        const { rows } = await client.query<ProviderEventRow>(
          `SELECT id, processed_at, failed_at FROM konektag.payment_provider_events
           WHERE provider = 'stripe' AND provider_event_id = $1 FOR UPDATE`,
          [input.id],
        );
        event = rows[0];
        if (!event || event.processed_at || event.failed_at) {
          await client.query('COMMIT');
          return { outcome: 'deduplicated' };
        }
      }

      if (input.type === 'payment_intent.payment_failed' || input.type === 'payment_intent.canceled') {
        const intent = input.paymentIntent;
        if (intent) {
          const { rows: failedAttempts } = await client.query<ProviderAttemptRow>(
            `SELECT id,source_type,source_id,operation_id,provider,provider_reference,expected_amount,expected_currency
             FROM konektag.payment_provider_attempts WHERE provider='stripe' AND provider_reference=$1 FOR UPDATE`, [intent.id]);
          const failedAttempt=failedAttempts[0];
          if(failedAttempt){const failedUpdate=await client.query(`UPDATE konektag.payment_provider_attempts SET state=$2,updated_at=now(),version=version+1 WHERE id=$1 AND state<>'succeeded'`,[failedAttempt.id,input.type==='payment_intent.canceled'?'cancelled':'failed']);if(failedUpdate.rowCount)await enqueueRechargeOperation(client,{provider:'stripe',providerReference:intent.id,status:'failed',failureReason:input.type==='payment_intent.canceled'?'CANCELED':'PAYMENT_FAILED'});await client.query(`UPDATE konektag.payment_provider_events SET attempt_id=$2,processed_at=now() WHERE id=$1`,[event.id,failedAttempt.id]);await client.query('COMMIT');return {outcome:'failed',sourceType:failedAttempt.source_type,sourceId:failedAttempt.source_id,providerReference:intent.id} as any;}
        }
      }
      if (input.type !== 'payment_intent.succeeded') {
        await client.query(
          `UPDATE konektag.payment_provider_events SET processed_at = now() WHERE id = $1`,
          [event.id],
        );
        await client.query('COMMIT');
        return { outcome: 'ignored' };
      }

      const intent = input.paymentIntent;
      if (!intent || intent.status !== 'succeeded') {
        await client.query(
          `UPDATE konektag.payment_provider_events
            SET failed_at = now(), error_code = 'invalid_payment_intent' WHERE id = $1`,
          [event.id],
        );
        await client.query('COMMIT');
        return { outcome: 'rejected' };
      }
      assertStripeIntent(intent);
      const { rows: attempts } = await client.query<ProviderAttemptRow>(
        `SELECT id, source_type, source_id, operation_id, provider, provider_reference, expected_amount, expected_currency
         FROM konektag.payment_provider_attempts
         WHERE provider = 'stripe' AND provider_reference = $1 FOR UPDATE`,
        [intent.id],
      );
      const attempt = attempts[0];
      if (!attempt || Number(attempt.expected_amount) !== intent.amount
        || attempt.expected_currency !== intent.currency.toUpperCase()) {
        await client.query(
          `UPDATE konektag.payment_provider_events
           SET attempt_id = $2, failed_at = now(), error_code = 'attempt_mismatch' WHERE id = $1`,
          [event.id, attempt?.id ?? null],
        );
        await client.query('COMMIT');
        return { outcome: 'rejected' };
      }
      const metadata = intent.metadata;
      if (metadata && Object.keys(metadata).length > 0 && (
        metadata.konektag_source_type !== attempt.source_type
        || metadata.konektag_source_id !== attempt.source_id
        || metadata.konektag_operation_id !== attempt.operation_id
      )) {
        await client.query(
          `UPDATE konektag.payment_provider_events
           SET attempt_id = $2, failed_at = now(), error_code = 'metadata_mismatch' WHERE id = $1`,
          [event.id, attempt.id],
        );
        await client.query('COMMIT');
        return { outcome: 'rejected' };
      }
      const card = stripeSafeCardDetails(intent.payment_method_details);
      await client.query(
        `UPDATE konektag.payment_provider_attempts
         SET state = 'succeeded', provider_country = COALESCE($2, provider_country),
             provider_card_brand = COALESCE($3, provider_card_brand),
             provider_card_funding = COALESCE($4, provider_card_funding),
             provider_card_bin = COALESCE($5, provider_card_bin), updated_at = now(), version = version + 1
         WHERE id = $1`,
        [attempt.id, card.country ?? null, card.brand ?? null, card.funding ?? null, card.bin ?? null],
      );
      await client.query(
        `UPDATE konektag.payment_provider_events SET attempt_id = $2 WHERE id = $1`,
        [event.id, attempt.id],
      );
      await enqueueRechargeOperation(client, { provider: 'stripe', providerReference: intent.id, status: 'paid' });
      await client.query('COMMIT');
      return { outcome: 'ready_to_settle', eventId: event.id, sourceType: attempt.source_type, sourceId: attempt.source_id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async markStripeEventProcessed(eventId: string): Promise<number> {
    const result = await pool.query(
      `UPDATE konektag.payment_provider_events SET processed_at = now(), error_code = NULL WHERE id = $1 AND processed_at IS NULL`,
      [eventId],
    );
    return result.rowCount ?? 0;
  },
};
