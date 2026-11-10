/**
 * "Régulariser" a Network operation from the Frappe back-office of its Network site.
 *
 * The API resolves server-side the owner site, the payment source and its reference, then:
 * - verify:          asks the authoritative source (PawaPay deposit, Stripe PaymentIntent with the
 *                    account that processed it, or the API Link Pay transaction) and applies a final
 *                    result through the existing processing (webhook path);
 * - confirm_paid:    an authorised operator records a confirmed payment with its evidence; the
 *                    existing finalisation credits Points K once / re-delivers the Link Pay webhooks;
 * - confirm_failed:  an authorised operator records a confirmed failure (recharges only).
 * It never starts a new payment. Manual results use provider events keyed manual:<attempt>:<result>,
 * the same idempotency as webhooks: a replay answers already_processed; a result contradicting a
 * final state answers conflict and keeps it. Every executed action is journaled (migration 233).
 */
import crypto from 'node:crypto';
import Stripe from 'stripe';
import pool from '../../infrastructure/database/pool.ts';
import { minorDigits } from '../services/pay/money-unit.ts';
import { resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';
import { enqueueNetworkOperation, enqueueRechargeOperation } from './network-operations.ts';

export const REGULATOR_ROLE = 'Konektag Network Regularizer';
export type RegularizationOption = 'verify' | 'confirm_paid' | 'confirm_failed';
export type RegularizationResult =
  'applied' | 'already_processed' | 'in_progress' | 'unavailable' | 'conflict' | 'temporary_failure' | 'refused';

export class RegularizationError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export interface Evidence { reference?: string; amount?: string | number; currency?: string; fileName?: string; fileSha256?: string }
export interface Operator { user: string; roles: string[] }

type Resolved =
  | { kind: 'recharge'; key: string; owner: string | null; attemptId: string; provider: 'stripe' | 'pawapay';
      reference: string; configurationKey: string | null; amountMinor: number; currency: string; attemptState: string;
      orderId: string; orderState: string; credited: boolean }
  | { kind: 'link'; key: string; owner: string; slug: string; checkoutIntentId: string; expiresAt: string; linkStatus: string;
      currency: string; amountMinor: number; transaction: { id: string; operationId: string; grossMinor: number } | null;
      deliveries: Array<{ id: string; target_site: string; status: string }> };

const FINAL_FAILED = ['failed', 'cancelled', 'expired'];
const major = (minor: number, currency: string) => minor / 10 ** minorDigits(currency);

function siteHost(key: string, env: NodeJS.ProcessEnv) {
  try { return new URL(env[`MARKETPLACE_FRAPPE_${key}_URL`] || '').host || null; } catch { return null; }
}

/** The authenticated Frappe site owns the operation (same key, or the same Frappe site under two keys). */
export function sameSite(authenticated: string, owner: string | null, env: NodeJS.ProcessEnv = process.env) {
  if (!owner) return false;
  if (authenticated === owner) return true;
  const a = siteHost(authenticated, env), b = siteHost(owner, env);
  return !!a && a === b;
}

export async function resolveOperation(key: string, env: NodeJS.ProcessEnv = process.env): Promise<Resolved> {
  const recharge = /^recharge:([0-9a-f-]{36})$/.exec(key);
  if (recharge) {
    const { rows: [row] } = await pool.query(
      `SELECT a.id, a.provider, a.provider_reference, a.metadata, a.expected_amount, a.expected_currency, a.state,
              o.id AS order_id, o.state AS order_state, o.order_metadata->'konektagSite'->>'slug' AS slug,
              EXISTS (SELECT 1 FROM konektag.points_acquisitions pa WHERE pa.order_id = o.id AND pa.status = 'completed') AS credited
       FROM konektag.payment_provider_attempts a
       JOIN konektag.api_payment_orders o ON a.source_type = 'api_payment' AND o.id::text = a.source_id::text
       WHERE a.id = $1 AND o.order_purpose = 'wallet_recharge'`, [recharge[1]]);
    if (!row || !['stripe', 'pawapay'].includes(row.provider)) throw new RegularizationError('OPERATION_NOT_FOUND', 404);
    return { kind: 'recharge', key, owner: row.slug ? resolveSlugSite(row.slug, env) : null, attemptId: row.id,
      provider: row.provider, reference: row.provider_reference,
      configurationKey: typeof row.metadata?.providerConfigurationKey === 'string' ? row.metadata.providerConfigurationKey : null,
      amountMinor: Number(row.expected_amount), currency: row.expected_currency, attemptState: row.state,
      orderId: row.order_id, orderState: row.order_state, credited: row.credited };
  }
  const link = /^link-pay:([a-f0-9]{16})$/.exec(key);
  if (link) {
    const { rows: [row] } = await pool.query(
      `SELECT ci.id, ci.public_id, ci.expiration, ci.status, ci.amount, ci.currency, nl.network_site,
              t.id AS tx_id, t.k_operation_id, t.gross_minor
       FROM konektag.checkout_intents ci
       JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
       LEFT JOIN konektag.link_pay_network_transactions t ON t.checkout_intent_id = ci.id
       WHERE ci.public_id = $1`, [link[1]]);
    if (!row) throw new RegularizationError('OPERATION_NOT_FOUND', 404);
    const { rows: deliveries } = row.tx_id ? await pool.query(
      `SELECT id, target_site, status FROM konektag.link_pay_site_webhooks WHERE transaction_id = $1 ORDER BY created_at`, [row.tx_id])
      : { rows: [] };
    return { kind: 'link', key, owner: row.network_site, slug: row.public_id, checkoutIntentId: row.id,
      expiresAt: new Date(row.expiration).toISOString(), linkStatus: row.status, currency: row.currency, amountMinor: Number(row.amount),
      transaction: row.tx_id ? { id: row.tx_id, operationId: row.k_operation_id, grossMinor: Number(row.gross_minor) } : null,
      deliveries };
  }
  throw new RegularizationError('OPERATION_KEY_INVALID', 400);
}

function rechargeFinal(op: Extract<Resolved, { kind: 'recharge' }>) {
  if (op.attemptState === 'succeeded') return 'paid';
  if (FINAL_FAILED.includes(op.attemptState)) return 'failed';
  return null;
}

function linkFinal(op: Extract<Resolved, { kind: 'link' }>) {
  if (op.transaction) return 'paid';
  if (new Date(op.expiresAt).getTime() <= Date.now()) return 'expired';
  return null;
}

/** Can the source be read for this operation? Null when available, else the reason. */
function verifyUnavailable(op: Resolved, env: NodeJS.ProcessEnv): string | null {
  if (op.kind === 'link') return null;
  if (op.provider === 'stripe') {
    if (!op.configurationKey) return 'STRIPE_ACCOUNT_UNKNOWN';
    return env[`${op.configurationKey}_SECRET_KEY`] ? null : 'STRIPE_ACCOUNT_NOT_CONFIGURED';
  }
  const configured = op.configurationKey
    ? env[`${op.configurationKey}_API_URL`] && env[`${op.configurationKey}_API_TOKEN`]
    : env.PAWAPAY_API_URL && env.PAWAPAY_API_TOKEN;
  return configured ? null : 'PAWAPAY_ACCOUNT_NOT_CONFIGURED';
}

export function optionsFor(op: Resolved, operator: Operator, env: NodeJS.ProcessEnv = process.env) {
  const regulator = operator.roles.includes(REGULATOR_ROLE);
  const final = op.kind === 'recharge' ? rechargeFinal(op) : linkFinal(op);
  const manual = (option: RegularizationOption) => {
    if (!regulator) return 'ROLE_REQUIRED';
    if (op.kind === 'link') {
      if (option === 'confirm_failed') return 'LINK_EXPIRES_AT_DEADLINE';
      return op.transaction ? null : 'NO_PAYMENT_RECORDED';
    }
    if (final) return `FINAL_STATUS_${final.toUpperCase()}`;
    return null;
  };
  const unavailable = verifyUnavailable(op, env);
  return [
    { option: 'verify', available: !unavailable, reason: unavailable },
    { option: 'confirm_paid', available: !manual('confirm_paid'), reason: manual('confirm_paid') },
    { option: 'confirm_failed', available: !manual('confirm_failed'), reason: manual('confirm_failed') },
  ];
}

export function describe(op: Resolved) {
  return op.kind === 'recharge'
    ? { type: 'points_k_recharge', provider: op.provider, providerReference: op.reference, providerAccount: op.configurationKey,
        amount: major(op.amountMinor, op.currency), currency: op.currency, apiState: op.attemptState, credited: op.credited }
    : { type: 'link_pay', provider: 'points_k', providerReference: op.transaction?.operationId ?? null, transaction: op.transaction?.id ?? null,
        amount: op.amountMinor / 10 ** minorDigits(op.currency), currency: op.currency, expiresAt: op.expiresAt,
        apiState: linkFinal(op) ?? 'pending', deliveries: op.deliveries.map(d => ({ site: d.target_site, status: d.status })) };
}

/** Stripe client of the account that processed the PaymentIntent. KONEKTAG_STRIPE_API_BASE: disposable tests only. */
function stripeFor(configurationKey: string, env: NodeJS.ProcessEnv) {
  const base = env.KONEKTAG_STRIPE_API_BASE ? new URL(env.KONEKTAG_STRIPE_API_BASE) : null;
  return new Stripe(env[`${configurationKey}_SECRET_KEY`]!, base ? {
    host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(':', '') as 'http' | 'https',
  } : undefined);
}

async function settleStripe(intent: Stripe.PaymentIntent, eventId: string, type: string) {
  const { paymentProviderAttemptService } = await import('../services/pay/payment-provider-attempt-service.ts');
  const { apiPaymentCheckoutService } = await import('../services/pay/api-payment-checkout-service.ts');
  const consumed: any = await paymentProviderAttemptService.consumeStripeEvent({ id: eventId, type,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex'), paymentIntent: intent as any });
  if (consumed.outcome === 'failed' && consumed.sourceType === 'api_payment')
    await apiPaymentCheckoutService.handleProviderAttemptFailure(consumed.sourceId, consumed.providerReference);
  if (consumed.outcome === 'ready_to_settle') {
    await apiPaymentCheckoutService.markFinalAndDispatch(consumed.sourceId, 'card', intent.id, consumed.eventId);
    await paymentProviderAttemptService.markStripeEventProcessed(consumed.eventId);
  }
  return consumed.outcome as string;
}

async function verify(op: Resolved, env: NodeJS.ProcessEnv): Promise<{ result: RegularizationResult; detail: Record<string, unknown> }> {
  if (op.kind === 'link') {
    const final = linkFinal(op);
    if (final === 'paid') {
      const pending = op.deliveries.filter(d => d.status !== 'delivered');
      if (!pending.length) return { result: 'already_processed', detail: { source: 'api_transaction', status: 'paid' } };
      await redeliverLink(op);
      return { result: 'applied', detail: { source: 'api_transaction', status: 'paid', redelivered: pending.map(d => d.target_site) } };
    }
    if (final === 'expired') {
      const queued = await enqueueLinkExpired(pool, op);
      return { result: queued ? 'applied' : 'already_processed', detail: { source: 'api_transaction', status: 'expired', expiresAt: op.expiresAt } };
    }
    return { result: 'in_progress', detail: { source: 'api_transaction', status: 'pending', expiresAt: op.expiresAt } };
  }
  const unavailable = verifyUnavailable(op, env);
  if (unavailable) return { result: 'unavailable', detail: { source: op.provider, reason: unavailable } };
  const before = rechargeFinal(op);
  if (op.provider === 'pawapay') {
    const { pawaPayClient } = await import('../../infrastructure/adapters/pawapay-client.ts');
    const { pawaPayDepositService } = await import('../services/pay/pawapay-deposit-service.ts');
    let deposit;
    try { deposit = await pawaPayClient.getDeposit(op.reference, op.configurationKey); }
    catch (error) {
      const message = (error as Error).message;
      if (message === 'PawaPay deposit NOT_FOUND') return { result: 'in_progress', detail: { source: 'pawapay', providerStatus: 'NOT_FOUND' } };
      return { result: 'unavailable', detail: { source: 'pawapay', reason: message } };
    }
    const status = String(deposit.status);
    if (status !== 'COMPLETED' && status !== 'FAILED') return { result: 'in_progress', detail: { source: 'pawapay', providerStatus: status } };
    const outcome = status === 'COMPLETED' ? 'paid' : 'failed';
    if (before && before !== outcome) return { result: 'conflict', detail: { source: 'pawapay', providerStatus: status, recorded: before } };
    await pawaPayDepositService.consume(deposit, JSON.stringify(deposit));
    const after = await resolveOperation(op.key, env) as typeof op;
    return { result: before === outcome && op.credited === after.credited ? 'already_processed' : 'applied',
      detail: { source: 'pawapay', providerStatus: status, credited: after.credited } };
  }
  let intent: Stripe.PaymentIntent;
  try { intent = await stripeFor(op.configurationKey!, env).paymentIntents.retrieve(op.reference); }
  catch (error) { return { result: 'unavailable', detail: { source: 'stripe', reason: (error as Error).message.slice(0, 200) } }; }
  const outcome = intent.status === 'succeeded' ? 'paid' : intent.status === 'canceled' ? 'failed' : null;
  if (!outcome) return { result: 'in_progress', detail: { source: 'stripe', providerStatus: intent.status } };
  if (before && before !== outcome) return { result: 'conflict', detail: { source: 'stripe', providerStatus: intent.status, recorded: before } };
  // Same processing as the verified webhook; the event id makes repeated verifications idempotent.
  await settleStripe(intent, `verify:${intent.id}:${intent.status}`,
    outcome === 'paid' ? 'payment_intent.succeeded' : 'payment_intent.canceled');
  const after = await resolveOperation(op.key, env) as typeof op;
  return { result: before === outcome && op.credited === after.credited ? 'already_processed' : 'applied',
    detail: { source: 'stripe', providerStatus: intent.status, credited: after.credited } };
}

function checkEvidence(op: Resolved, evidence: Evidence) {
  const amount = Number(evidence.amount);
  const references = op.kind === 'recharge' ? [op.reference] : [op.transaction?.id, op.transaction?.operationId].filter(Boolean);
  const expected = op.kind === 'recharge' ? major(op.amountMinor, op.currency) : op.amountMinor / 10 ** minorDigits(op.currency);
  const missing = [];
  if (!evidence.fileSha256 || !/^[a-f0-9]{64}$/.test(evidence.fileSha256)) missing.push('justificatif');
  if (!evidence.reference || !references.includes(evidence.reference)) missing.push('référence');
  if (!Number.isFinite(amount) || Math.abs(amount - expected) > 1e-9) missing.push('montant');
  if ((evidence.currency || '').toUpperCase() !== op.currency) missing.push('devise');
  return { missing, expected: { references, amount: expected, currency: op.currency } };
}

async function redeliverLink(op: Extract<Resolved, { kind: 'link' }>) {
  const { siteWebhookService } = await import('../link-pay/site-webhook-service.ts');
  // Re-deliver what did not reach the sites (network first; the merchant follows its acknowledgement).
  await pool.query(
    `UPDATE konektag.link_pay_site_webhooks SET status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'pending' END,
            attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
     WHERE transaction_id = $1 AND status IN ('failed', 'dead_lettered')`, [op.transaction!.id]);
  const { rows } = await pool.query(
    `SELECT id FROM konektag.link_pay_site_webhooks WHERE transaction_id = $1 AND status = 'pending'`, [op.transaction!.id]);
  for (const row of rows) await siteWebhookService.deliver(row.id);
}

export async function enqueueLinkExpired(db: Pick<import('pg').PoolClient, 'query'>, op: { slug: string; owner: string; checkoutIntentId: string; expiresAt: string }) {
  const { rowCount } = await db.query(`SELECT 1 FROM konektag.outbox_events WHERE event_type='NetworkOperationChanged' AND aggregate_ref=$1`,
    [`link-pay:${op.slug}:expired`]);
  if (rowCount) return false;
  await enqueueNetworkOperation(db, { site: op.owner, aggregateId: op.checkoutIntentId, operation: {
    key: `link-pay:${op.slug}`, type: 'link_pay', status: 'expired', eventKey: `link-pay:${op.slug}:expired`, reference: op.slug,
    settledAt: op.expiresAt, expiresAt: op.expiresAt } as any });
  return true;
}

async function confirmRecharge(op: Extract<Resolved, { kind: 'recharge' }>, outcome: 'paid' | 'failed', reason: string, evidence: Evidence)
  : Promise<{ result: RegularizationResult; detail: Record<string, unknown> }> {
  const recorded = rechargeFinal(op);
  if (recorded && recorded !== outcome) return { result: 'conflict', detail: { recorded } };
  const { paymentProviderAttemptService } = await import('../services/pay/payment-provider-attempt-service.ts');
  const { apiPaymentCheckoutService } = await import('../services/pay/api-payment-checkout-service.ts');
  const eventKey = `manual:${op.attemptId}:${outcome}`;
  const client = await pool.connect();
  let eventId: string;
  try {
    await client.query('BEGIN');
    const { rows: [attempt] } = await client.query(
      `SELECT state FROM konektag.payment_provider_attempts WHERE id = $1 FOR UPDATE`, [op.attemptId]);
    const now = attempt.state === 'succeeded' ? 'paid' : FINAL_FAILED.includes(attempt.state) ? 'failed' : null;
    if (now && now !== outcome) { await client.query('ROLLBACK'); return { result: 'conflict', detail: { recorded: now } }; }
    const { rows: [event] } = await client.query(
      `INSERT INTO konektag.payment_provider_events (provider, provider_event_id, event_type, payload_hash, attempt_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_event_id) DO UPDATE SET attempt_id = EXCLUDED.attempt_id
       RETURNING id, processed_at`,
      [op.provider, eventKey, `manual.${outcome}`, evidence.fileSha256, op.attemptId]);
    eventId = event.id;
    if (!now) {
      await client.query(`UPDATE konektag.payment_provider_attempts SET state = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
        [op.attemptId, outcome === 'paid' ? 'succeeded' : 'failed']);
      await enqueueRechargeOperation(client, { provider: op.provider, providerReference: op.reference, status: outcome,
        failureReason: outcome === 'failed' ? `MANUAL: ${reason}` : null });
    }
    if (outcome === 'failed') await client.query(`UPDATE konektag.payment_provider_events SET processed_at = COALESCE(processed_at, now()) WHERE id = $1`, [eventId]);
    await client.query('COMMIT');
    if (now === outcome && (outcome === 'failed' || op.credited)) return { result: 'already_processed', detail: { recorded: now, credited: op.credited } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  if (outcome === 'failed') {
    await apiPaymentCheckoutService.handleProviderAttemptFailure(op.orderId, op.reference);
    return { result: 'applied', detail: { status: 'failed' } };
  }
  // Existing finalisation: one Points K credit per order, whatever webhook or regularisation comes first.
  try {
    await apiPaymentCheckoutService.markFinalAndDispatch(op.orderId, op.provider === 'stripe' ? 'card' : 'mobile_money', op.reference, eventId);
    await paymentProviderAttemptService.markStripeEventProcessed(eventId);
  } catch (error) {
    const after = await resolveOperation(op.key) as typeof op;
    if (after.credited) return { result: 'already_processed', detail: { status: 'paid', credited: true } };
    // The attempt is confirmed: the worker's acquisition recovery also resumes this credit.
    return { result: 'temporary_failure', detail: { status: 'paid', credited: false, reason: (error as Error).message.slice(0, 200) } };
  }
  const after = await resolveOperation(op.key) as typeof op;
  return { result: 'applied', detail: { status: 'paid', credited: after.credited } };
}

export async function regularize(input: { site: string; key: string; option: string; operator: Operator; reason?: string;
  evidence?: Evidence; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env;
  if (!input.operator?.user || !Array.isArray(input.operator.roles)) throw new RegularizationError('OPERATOR_REQUIRED', 400);
  const op = await resolveOperation(input.key, env);
  if (!sameSite(input.site, op.owner, env)) throw new RegularizationError('OPERATION_OF_ANOTHER_SITE', 403);
  if (input.option === 'options') return { key: op.key, operation: describe(op), options: optionsFor(op, input.operator, env) };
  if (!['verify', 'confirm_paid', 'confirm_failed'].includes(input.option)) throw new RegularizationError('OPTION_INVALID', 400);
  const option = input.option as RegularizationOption;
  const allowed = optionsFor(op, input.operator, env).find(o => o.option === option)!;
  let outcome: { result: RegularizationResult; detail: Record<string, unknown> };
  const reason = (input.reason || '').trim().slice(0, 1000);
  const evidence = input.evidence ?? {};
  if (!allowed.available && option !== 'verify' && allowed.reason?.startsWith('FINAL_STATUS_')) {
    const recorded = allowed.reason.slice('FINAL_STATUS_'.length).toLowerCase();
    outcome = { result: recorded === (option === 'confirm_paid' ? 'paid' : 'failed') ? 'already_processed' : 'conflict', detail: { recorded } };
  } else if (!allowed.available) {
    outcome = option === 'verify' ? { result: 'unavailable', detail: { reason: allowed.reason } }
      : { result: 'refused', detail: { reason: allowed.reason } };
  } else if (option === 'verify') {
    outcome = await verify(op, env);
  } else if (reason.length < 10) {
    outcome = { result: 'refused', detail: { reason: 'REASON_REQUIRED' } };
  } else {
    const check = checkEvidence(op, evidence);
    if (check.missing.length) outcome = { result: 'refused', detail: { reason: 'EVIDENCE_MISMATCH', missing: check.missing, expected: check.expected } };
    else if (op.kind === 'link') {
      const pending = op.deliveries.filter(d => d.status !== 'delivered');
      if (pending.length) await redeliverLink(op);
      outcome = { result: pending.length ? 'applied' : 'already_processed', detail: { status: 'paid', transaction: op.transaction!.id } };
    } else {
      try { outcome = await confirmRecharge(op, option === 'confirm_paid' ? 'paid' : 'failed', reason, evidence); }
      catch (error) { outcome = { result: 'temporary_failure', detail: { reason: (error as Error).message.slice(0, 200) } }; }
    }
  }
  await pool.query(
    `INSERT INTO konektag.network_operation_regularizations
       (site_key, operation_key, option, operator_user, operator_roles, reason, evidence, result, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)`,
    [input.site, op.key, option, input.operator.user.slice(0, 140), input.operator.roles.slice(0, 50), reason || null,
     JSON.stringify(evidence), outcome.result, JSON.stringify(outcome.detail)]);
  const current = await resolveOperation(op.key, env);
  return { key: op.key, option, ...outcome, operation: describe(current) };
}

/** Worker pass: unpaid network links past their deadline become Expiré on their Network site. */
export async function expireDueLinks(limit = 100) {
  const { rows } = await pool.query(
    `SELECT ci.id, ci.public_id, ci.expiration, nl.network_site FROM konektag.checkout_intents ci
     JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
     WHERE ci.expiration <= now() AND ci.status IN ('ISSUED', 'EXPIRED')
       AND NOT EXISTS (SELECT 1 FROM konektag.link_pay_network_transactions t WHERE t.checkout_intent_id = ci.id)
       AND NOT EXISTS (SELECT 1 FROM konektag.outbox_events e WHERE e.event_type = 'NetworkOperationChanged'
                       AND e.aggregate_ref = 'link-pay:' || ci.public_id || ':expired')
     ORDER BY ci.expiration LIMIT $1`, [limit]);
  for (const row of rows) await enqueueLinkExpired(pool, { slug: row.public_id, owner: row.network_site, checkoutIntentId: row.id,
    expiresAt: new Date(row.expiration).toISOString() });
  return rows.length;
}
