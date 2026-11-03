import pool from '../../infrastructure/database/pool.ts';
import type { RechargeStatus, ProviderStatusDetail, LedgerStatus } from '../../domain/RechargeProjection.ts';
import { assertValidRechargeTransition, assertValidProviderTransition, assertValidLedgerTransition } from '../../domain/RechargeWorkflow.ts';
import crypto from 'node:crypto';

interface RechargeEventPayload {
  rechargeName: string;
  keycloakId?: string;
  requestedAmount?: number;
  requestedCurrency?: string;
  paymentMethod?: 'card' | 'mobile_money' | 'crypto';
  paymentProvider?: string | null;
  country?: string | null;
  internalReference?: string | null;
  mobileMoneyOperator?: string | null;
  mobileMoneyPhone?: string | null;
  cryptoNetwork?: string | null;
  cryptoAddress?: string | null;
  providerReference?: string | null;
  providerStatus?: string | null;
  providerPayload?: Record<string, unknown> | null;
  creditedAmount?: number;
  creditedCurrency?: string;
  ledgerDocumentRef?: string;
  sourceOperationId?: string;
  reason?: string;
  adminId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface StripeRechargeSource {
  rechargeName: string;
  keycloakId: string;
  userId: string | null;
  requestedAmount: number;
  requestedCurrency: string;
  paymentMethod: string;
  rechargeStatus: string;
  country: string | null;
}

function computeChecksum(data: {
  rechargeName: string; keycloakId: string;
  requestedAmount: number; requestedCurrency: string;
  paymentMethod: string; paymentProvider: string | null;
  rechargeStatus: string; providerStatusDetail: string | null; ledgerStatus: string;
  creditedAmount: number | null; creditedCurrency: string | null;
}): string {
  const canonical = [
    data.rechargeName,
    data.keycloakId,
    String(data.requestedAmount),
    data.requestedCurrency,
    data.paymentMethod,
    data.paymentProvider || '',
    data.rechargeStatus,
    data.providerStatusDetail || '',
    data.ledgerStatus,
    data.creditedAmount != null ? String(data.creditedAmount) : '',
    data.creditedCurrency || '',
  ].join('|');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function projectCreated(payload: RechargeEventPayload): Promise<string | null> {
  const name = payload.rechargeName;
  if (!name) return null;
  if (!payload.keycloakId || !payload.requestedAmount || !payload.requestedCurrency || !payload.paymentMethod) {
    throw new Error(`RechargeCreated missing mandatory fields for ${name}`);
  }

  const { rows } = await pool.query(
    `INSERT INTO konektag.recharge_projection
     (recharge_name, keycloak_id, requested_amount, requested_currency,
      payment_method, payment_provider,
      recharge_status, provider_status_detail, ledger_status,
      country, internal_reference,
      mobile_money_operator, mobile_money_phone,
      crypto_network, crypto_address,
      provider_reference,
      projection_version, source_updated_at,
      projection_checksum, checksum_version, causation_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending','not_submitted','not_posted',$7,$8,$9,$10,$11,$12,$13,1,now(),$14,1,$15)
     ON CONFLICT (recharge_name) DO UPDATE SET
       projection_version = konektag.recharge_projection.projection_version + 1,
       updated_at = now(),
       source_updated_at = now()
     WHERE konektag.recharge_projection.deleted_at IS NULL
       AND konektag.recharge_projection.projection_version = 0
     RETURNING id, projection_version`,
    [
      name, payload.keycloakId, payload.requestedAmount, payload.requestedCurrency,
      payload.paymentMethod, payload.paymentProvider || null,
      payload.country || null, payload.internalReference || name,
      payload.mobileMoneyOperator || null, payload.mobileMoneyPhone || null,
      payload.cryptoNetwork || null, payload.cryptoAddress || null,
      payload.providerReference || null,
      computeChecksum({
        rechargeName: name, keycloakId: payload.keycloakId,
        requestedAmount: payload.requestedAmount, requestedCurrency: payload.requestedCurrency,
        paymentMethod: payload.paymentMethod, paymentProvider: payload.paymentProvider || null,
        rechargeStatus: 'pending', providerStatusDetail: null, ledgerStatus: 'not_posted',
        creditedAmount: null, creditedCurrency: null,
      }),
      payload.causationId || null,
    ],
  );

  if (rows.length === 0) return null;

  await pool.query(
    `INSERT INTO konektag.recharge_events (recharge_id, to_status, reason, payload)
     VALUES ($1, 'pending', 'Recharge créée', $2)`,
    [rows[0].id, JSON.stringify({ rechargeName: name, source: 'RechargeCreated' })],
  );

  return rows[0].id;
}

async function projectConfirmed(payload: RechargeEventPayload, eventId?: string): Promise<void> {
  const name = payload.rechargeName;
  if (!name) return;

  const { rows: [existing] } = await pool.query(
    `SELECT id, recharge_status, provider_status_detail, ledger_status, projection_version
     FROM konektag.recharge_projection
     WHERE recharge_name = $1 AND deleted_at IS NULL`,
    [name],
  );

  if (!existing) {
    await blockEvent(eventId, 'blocked_missing_predecessor', `RechargeConfirmed before RechargeCreated for ${name}`);
    return;
  }

  try {
    assertValidRechargeTransition(existing.recharge_status, 'confirmed');
  } catch {
    if (existing.recharge_status === 'confirmed') return;
    await blockEvent(eventId, 'blocked_invalid_transition', `Cannot transition from ${existing.recharge_status} to confirmed`);
    return;
  }

  // Verify ledger
  let creditedAmount: number | null = null;
  let creditedCurrency: string | null = null;
  if (payload.ledgerDocumentRef) {
    const { rows: [ledgerRow] } = await pool.query(
      `SELECT amount, currency FROM konektag.ledger_entries
       WHERE document_ref = $1 AND entry_type = 'credit'
         AND document_type = 'Recharge'
         AND (is_reversal = false OR is_reversal IS NULL)
       LIMIT 1`,
      [payload.ledgerDocumentRef],
    );
    if (ledgerRow) {
      creditedAmount = Number(ledgerRow.amount);
      creditedCurrency = ledgerRow.currency;
    } else {
      await blockEvent(eventId, 'blocked_ledger_missing', `No ledger credit for ${payload.ledgerDocumentRef}`);
      return;
    }
  } else if (payload.creditedAmount !== undefined) {
    creditedAmount = payload.creditedAmount;
    creditedCurrency = payload.creditedCurrency || 'XOF';
  }

  const providerPayload = payload.providerPayload ? JSON.stringify(payload.providerPayload) : null;

  const chk = computeChecksum({
    rechargeName: name, keycloakId: existing.keycloak_id || '',
    requestedAmount: existing.requested_amount || payload.creditedAmount || 0,
    requestedCurrency: existing.requested_currency || 'XOF',
    paymentMethod: existing.payment_method || 'card',
    paymentProvider: existing.payment_provider || null,
    rechargeStatus: 'confirmed',
    providerStatusDetail: payload.providerStatus || existing.provider_status_detail || 'completed',
    ledgerStatus: creditedAmount ? 'posted' : existing.ledger_status || 'not_posted',
    creditedAmount, creditedCurrency,
  });

  await pool.query(
    `UPDATE konektag.recharge_projection SET
       recharge_status = 'confirmed',
       provider_status_detail = $2,
       ledger_status = $3,
       credited_amount = $4,
       credited_currency = $5,
       provider_reference = $6,
       provider_payload = $7,
       confirmed_at = COALESCE(confirmed_at, now()),
       projection_version = projection_version + 1,
       last_event_id = $8,
       projected_at = now(),
       updated_at = now(),
       source_updated_at = now(),
       projection_checksum = $9,
       checksum_version = 1,
       causation_id = $10
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      existing.id,
      payload.providerStatus || 'completed',
      creditedAmount ? 'posted' : 'not_posted',
      creditedAmount, creditedCurrency,
      payload.providerReference || null,
      providerPayload,
      eventId || null,
      chk,
      payload.causationId || null,
    ],
  );

  await pool.query(
    `INSERT INTO konektag.recharge_events (recharge_id, from_status, to_status, reason, payload)
     VALUES ($1, $2, 'confirmed', 'Paiement confirmé', $3)`,
    [existing.id, existing.recharge_status, JSON.stringify({ source: 'RechargeCompleted' })],
  );
}

async function transitionRechargeStatus(
  rechargeName: string,
  toStatus: RechargeStatus,
  extra: {
    providerRef?: string | null;
    providerStatus?: string | null;
    providerPayload?: Record<string, unknown> | null;
    reason?: string;
    reversedAt?: string;
    eventId?: string;
    causationId?: string;
  } = {},
): Promise<void> {
  if (!rechargeName) return;

  const { rows: [existing] } = await pool.query(
    `SELECT id, recharge_status, provider_status_detail, ledger_status,
            requested_amount, requested_currency, payment_method, payment_provider,
            keycloak_id, credited_amount, credited_currency
     FROM konektag.recharge_projection
     WHERE recharge_name = $1 AND deleted_at IS NULL`,
    [rechargeName],
  );

  if (!existing) {
    await blockEvent(extra.eventId, 'blocked_missing_predecessor', `Event before RechargeCreated for ${rechargeName}`);
    return;
  }

  try { assertValidRechargeTransition(existing.recharge_status, toStatus); }
  catch {
    if (existing.recharge_status === toStatus) return;
    await blockEvent(extra.eventId, 'blocked_invalid_transition',
      `Cannot transition recharge from ${existing.recharge_status} to ${toStatus}`);
    return;
  }

  const providerPayload = extra.providerPayload ? JSON.stringify(extra.providerPayload) : null;

  const chk = computeChecksum({
    rechargeName, keycloakId: existing.keycloak_id,
    requestedAmount: existing.requested_amount, requestedCurrency: existing.requested_currency,
    paymentMethod: existing.payment_method, paymentProvider: existing.payment_provider,
    rechargeStatus: toStatus,
    providerStatusDetail: extra.providerStatus || existing.provider_status_detail || null,
    ledgerStatus: existing.ledger_status,
    creditedAmount: existing.credited_amount, creditedCurrency: existing.credited_currency,
  });

  await pool.query(
    `UPDATE konektag.recharge_projection SET
       recharge_status = $2,
       projection_version = projection_version + 1,
       last_event_id = $3,
       projected_at = now(),
       updated_at = now(),
       source_updated_at = now(),
       provider_reference = CASE WHEN $4::varchar IS NOT NULL THEN $4::varchar ELSE provider_reference END,
       provider_status_detail = CASE WHEN $5::varchar IS NOT NULL THEN $5::varchar ELSE provider_status_detail END,
       provider_payload = CASE WHEN $6::jsonb IS NOT NULL THEN $6::jsonb ELSE provider_payload END,
       reversed_at = CASE WHEN $7::timestamptz IS NOT NULL THEN $7::timestamptz ELSE reversed_at END,
       projection_checksum = $8,
       causation_id = $9
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      existing.id, toStatus, extra.eventId || null,
      extra.providerRef || null, extra.providerStatus || null,
      providerPayload, extra.reversedAt || null,
      chk, extra.causationId || null,
    ],
  );

  await pool.query(
    `INSERT INTO konektag.recharge_events (recharge_id, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4)`,
    [existing.id, existing.recharge_status, toStatus, extra.reason || null],
  );
}

async function blockEvent(eventId: string | undefined, reason: string, detail: string): Promise<void> {
  if (!eventId) return;
  await pool.query(
    `UPDATE konektag.outbox_events SET
       blocked_reason = $2, blocked_at = now(),
       next_retry_at = now() + make_interval(mins => 2),
       error_message = $3
     WHERE id = $1`,
    [eventId, reason, detail],
  );
}

export const rechargeProjection = {
  async projectEvent(eventType: string, payload: RechargeEventPayload, eventId?: string): Promise<void> {
    switch (eventType) {
      case 'RechargeCreated':          await projectCreated(payload); break;
      case 'RechargeConfirmed':        await projectConfirmed(payload, eventId); break;
      case 'RechargeProviderReceived':  await transitionRechargeStatus(payload.rechargeName, 'confirmed', {
                                          providerRef: payload.providerReference, providerStatus: payload.providerStatus,
                                          providerPayload: payload.providerPayload, reason: 'Reçu par le fournisseur',
                                          eventId, causationId: payload.causationId,
                                        }); break;
      case 'RechargeFailed':           await transitionRechargeStatus(payload.rechargeName, 'failed', {
                                          reason: payload.reason || 'Échec', providerStatus: payload.providerStatus,
                                          eventId, causationId: payload.causationId,
                                        }); break;
      case 'RechargeReversed':         await transitionRechargeStatus(payload.rechargeName, 'reversed', {
                                          reason: payload.reason || 'Annulation', reversedAt: new Date().toISOString(),
                                          eventId, causationId: payload.causationId,
                                        }); break;
      case 'RechargeProjectionRequested': await projectCreated(payload); break;
    }
  },

  async getProjectionStatus(rechargeName: string): Promise<{
    exists: boolean;
    rechargeStatus: string | null;
    projectionVersion: number;
  } | null> {
    const { rows: [r] } = await pool.query(
      `SELECT id, recharge_status, projection_version FROM konektag.recharge_projection
       WHERE recharge_name = $1 AND deleted_at IS NULL`,
      [rechargeName],
    );
    if (!r) return null;
    return { exists: true, rechargeStatus: r.recharge_status, projectionVersion: r.projection_version };
  },

  async getStripeConfirmationSource(rechargeName: string): Promise<StripeRechargeSource | null> {
    const { rows: [r] } = await pool.query(
      `SELECT recharge_name, keycloak_id, user_id, requested_amount, requested_currency,
              payment_method, recharge_status, country
       FROM konektag.recharge_projection
       WHERE recharge_name = $1 AND deleted_at IS NULL`,
      [rechargeName],
    );
    if (!r) return null;
    return {
      rechargeName: r.recharge_name,
      keycloakId: r.keycloak_id,
      userId: r.user_id,
      requestedAmount: Number(r.requested_amount),
      requestedCurrency: r.requested_currency,
      paymentMethod: r.payment_method,
      rechargeStatus: r.recharge_status,
      country: r.country,
    };
  },

  async enqueueStripeConfirmation(input: {
    rechargeName: string;
    amount: number;
    currency: string;
    paymentIntentId: string;
    transactionId: string;
  }): Promise<void> {
    const correlationId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO konektag.outbox_events
       (correlation_id, causation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
       VALUES ($1, $1, 'Recharge', gen_random_uuid(), $2, 'RechargeConfirmed', 1, $3)`,
      [correlationId, input.rechargeName, JSON.stringify({
        rechargeName: input.rechargeName,
        creditedAmount: input.amount,
        creditedCurrency: input.currency,
        providerReference: input.paymentIntentId,
        providerStatus: 'completed',
        sourceOperationId: input.transactionId,
        correlationId,
        causationId: correlationId,
      })],
    );
  },
};
