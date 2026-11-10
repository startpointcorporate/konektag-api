import { deliverCashReceipt } from './services/cash-receipt-service.ts';
import pool from '../infrastructure/database/pool.ts';
import { KeycloakAdapter } from '../infrastructure/adapters/keycloak-adapter.ts';
import { encryptionService } from '../infrastructure/adapters/encryption-service.ts';
import { emailService } from './services/resend-service.ts';
import { processKycOrder } from './services/kyc-processor.ts';
import { mauticContactSyncService } from './services/mautic-contact-sync-service.ts';
import { mauticCompanySyncService } from './services/mautic-company-sync-service.ts';
import { mauticMarketingSyncService } from './services/mautic-marketing-sync-service.ts';
import { erpnextContactService } from './services/erpnext-contact-service.ts';
import { getCorrelationId } from '../infrastructure/correlation-id.ts';
import { rechargeProjection } from './projection/recharge-projection.ts';
import {
  PermanentOutboxError,
  OUTBOX_KEYCLOAK_ID_MISSING,
  OUTBOX_RECIPIENT_INVALID,
  OUTBOX_RECIPIENT_NOT_FOUND,
} from './outbox-errors.ts';
import {
  PROCESS_IDS,
  recordWorkerHeartbeat,
  registerWorkerRun,
} from './services/process-evidence-service.ts';
import crypto from 'node:crypto';
import {
  dispatchFrappeProjectionEvent,
  isFrappeProjectionEvent,
} from '../infrastructure/adapters/frappe-integration-client.ts';

const keycloakForDispatch = new KeycloakAdapter(
  process.env.KEYCLOAK_BASE_URL ?? 'http://common-keycloak:8080',
  process.env.KEYCLOAK_REALM ?? 'konektag',
  process.env.KEYCLOAK_CLIENT_ID ?? 'frontend-konektag',
  process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'directus-konektag',
  process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '',
  process.env.KEYCLOAK_EXTERNAL_BASE_URL || process.env.PUBLIC_SITE_URL || 'https://login.konektag.eu',
);

const MAX_RETRY_ATTEMPTS = 5;
const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '15000', 10);
const LOCK_TIMEOUT_MS = 10000;
const STATEMENT_TIMEOUT_MS = 60000;
const BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE || '50', 10);

// Retry backoff schedule (in seconds)
const RETRY_BACKOFF = [0, 30, 120, 600, 3600]; // immediate, 30s, 2min, 10min, 1h

let running = false;
let fallbackInterval: ReturnType<typeof setInterval> | null = null;
// GAP-024: durable evidence run identity for this worker process.
let evidenceRunId: string | null = null;

// ── Metrics counters ──
const metrics = {
  pendingCount: 0,
  oldestPendingAge: 0,
  retryCount: 0,
  deadLetterCount: 0,
  blockedCount: 0,
  // Enhanced metrics
  projectionDelay: 0,
  meanProjectionTime: 0,
  maxProjectionTime: 0,
  projectionFailuresPerMinute: 0,
  blockedPerReason: {} as Record<string, number>,
  deadLettersPerReason: {} as Record<string, number>,
  externalCallFailures: 0,
  erpnextLatency: 0,
  providerLatency: 0,
  _recentDurations: [] as number[],
  _failureTimestamps: [] as number[],
  _sampleIndex: 0,
};

export async function startOutboxDispatcher(): Promise<void> {
  if (running) return;
  running = true;

  console.log('[Outbox] Starting dispatcher...');
  console.log(`[Outbox] Poll interval: ${POLL_INTERVAL_MS}ms, Batch: ${BATCH_SIZE}, Max retries: ${MAX_RETRY_ATTEMPTS}`);

  // GAP-024: register durable worker evidence (never breaks startup; health
  // evaluation fails closed when evidence is missing or stale).
  evidenceRunId = await registerWorkerRun(PROCESS_IDS.outboxDispatcher);

  await processPending();

  fallbackInterval = setInterval(() => {
    processPending().catch(err => console.error('[Outbox] Fallback error:', err));
  }, POLL_INTERVAL_MS);

  console.log('[Outbox] Dispatcher started');
}

export function getOutboxMetrics() {
  return { ...metrics };
}

// Exported for focused unit tests; runtime entry point remains startOutboxDispatcher().
export async function processPending(): Promise<void> {
  try {
    const { apiPaymentWebhookService } = await import('./services/pay/api-payment-webhook-service.ts');
    await apiPaymentWebhookService.processDue();
  } catch (error) {
    console.error('[Outbox] API payment webhook retry processing failed');
  }

  // Link Pay webhooks to Frappe sites (network first, then beneficiary), same retry schedule.
  try {
    const { siteWebhookService } = await import('./link-pay/site-webhook-service.ts');
    await siteWebhookService.processDue();
  } catch (error) {
    console.error('[Outbox] Link Pay site webhook processing failed');
  }

  // Reconcile non-terminal PawaPay deposits against the provider on every worker pass.
  // A missing webhook therefore does not leave a Mobile Money payment indefinitely stale.
  try {
    const { pawaPayDepositService } = await import('./services/pay/pawapay-deposit-service.ts');
    await pawaPayDepositService.reconcile(20);
  } catch (error) {
    console.error('[pawapay-reconciliation] failed', (error as Error).message);
  }

  try {
    const { apiPaymentCheckoutService } = await import('./services/pay/api-payment-checkout-service.ts');
    const { rows: recoverable } = await pool.query<{
      event_id:string; source_id:string; provider:string; provider_reference:string;
    }>(`
      SELECT e.id AS event_id,a.source_id,a.provider,a.provider_reference
      FROM konektag.payment_provider_events e
      JOIN konektag.payment_provider_attempts a ON a.id=e.attempt_id
      JOIN konektag.api_payment_orders o ON o.id::text=a.source_id::text
      WHERE e.failed_at IS NULL
        AND a.source_type='api_payment' AND a.state='succeeded'
        AND o.order_purpose='wallet_recharge'
        -- A terminal checkout must never be resurrected by acquisition recovery.
        -- Provider evidence is retained for audit, but expired/failed/cancelled
        -- orders are intentionally excluded from financial finalisation.
        AND o.state NOT IN ('expired','failed','cancelled')
        AND a.provider IN ('stripe','pawapay','manual')
        AND NOT EXISTS (
          SELECT 1 FROM konektag.points_acquisitions pa
          WHERE pa.order_id=o.id AND pa.status='completed'
        )
      ORDER BY e.received_at
      LIMIT 20
    `);
    for (const item of recoverable) {
      try {
        const method = item.provider === 'stripe' ? 'card' : 'mobile_money';
        await apiPaymentCheckoutService.markFinalAndDispatch(item.source_id, method, item.provider_reference, item.event_id);
        await pool.query(`UPDATE konektag.payment_provider_events SET processed_at=now(),error_code=NULL WHERE id=$1 AND processed_at IS NULL`,[item.event_id]);
        console.log('[points-acquisition-recovery] resumed', item.source_id);
      } catch (error) {
        console.error('[points-acquisition-recovery] retry failed', item.source_id, (error as Error).message);
      }
    }
  } catch (error) {
    console.error('[points-acquisition-recovery] scan failed', (error as Error).message);
  }

  // GAP-024: liveness heartbeat — the worker stays serving even when evidence
  // persistence fails; health evaluation then fails closed on stale evidence.
  if (evidenceRunId) {
    try {
      await recordWorkerHeartbeat(PROCESS_IDS.outboxDispatcher, evidenceRunId);
    } catch (err) {
      console.error('[Outbox] Evidence heartbeat failed:', (err as Error).message);
    }
  }
  const client = await pool.connect();
  try {
    // Query pending events (including retryable blocked events)
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);

    const { rows } = await client.query(`
      SELECT * FROM konektag.outbox_events
      WHERE processed_at IS NULL
        AND dead_lettered_at IS NULL
        AND COALESCE(next_retry_at, now()) <= now()
        AND (blocked_reason IS NULL OR COALESCE(next_retry_at, now()) <= now())
      ORDER BY created_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [BATCH_SIZE]);

    await client.query('COMMIT');

    // Update metrics
    metrics.pendingCount = rows.length;
    let totalDuration = 0;
    let maxDuration = 0;
    let processedCount = 0;

    for (const event of rows) {
      const startTime = Date.now();
      try {
        await dispatch(event);
        const duration = Date.now() - startTime;
        await pool.query(
          `UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`,
          [event.id],
        );
        totalDuration += duration;
        maxDuration = Math.max(maxDuration, duration);
        processedCount++;
        logEvent('processed', event, duration);
      } catch (error) {
        const attempts = (event.attempts || 0) + 1;

        if (error instanceof PermanentOutboxError) {
          // Objectively undeliverable (e.g. authoritative recipient absent or
          // malformed): stop normal retry scheduling and dead-letter immediately
          // with a sanitized reason code. The batch continues with other events.
          // If the terminal state cannot be persisted, deadLetter throws and the
          // event stays pending (fail closed) instead of being lost or delivered.
          const reasonCode = error.reasonCode;
          metrics.deadLettersPerReason[reasonCode] = (metrics.deadLettersPerReason[reasonCode] || 0) + 1;
          await deadLetter(event, reasonCode, attempts);
          metrics.deadLetterCount++;
          logEvent('dead_letter', event, Date.now() - startTime, reasonCode, attempts);
          continue;
        }

        const errMsg = (error as Error).message;

        // A rejected integration credential cannot self-heal by retrying. Keep
        // the immutable event for operations in the dead-letter queue instead
        // of leaving Settlement projections in an endless 403 loop.
        if (isFrappeProjectionEvent(event.event_type) && /^FRAPPE_INTEGRATION_HTTP_(401|403)$/.test(errMsg)) {
          metrics.deadLettersPerReason[errMsg] = (metrics.deadLettersPerReason[errMsg] || 0) + 1;
          await deadLetter(event, errMsg, attempts);
          metrics.deadLetterCount++;
          logEvent('dead_letter', event, Date.now() - startTime, errMsg, attempts);
          continue;
        }

        // Track blocked reasons
        metrics.blockedPerReason[errMsg] = (metrics.blockedPerReason[errMsg] || 0) + 1;

        if (isBlockedError(errMsg)) {
          if (attempts >= MAX_RETRY_ATTEMPTS) {
            // A blocked event that exhausts the shared attempt budget is
            // terminally undeliverable: stop retry scheduling and move it
            // through the established dead-letter mechanism instead of
            // reselecting it on every worker run forever.
            metrics.deadLettersPerReason[errMsg] = (metrics.deadLettersPerReason[errMsg] || 0) + 1;
            await deadLetter(event, errMsg, attempts);
            metrics.deadLetterCount++;
            logEvent('dead_letter', event, Date.now() - startTime, errMsg, attempts);
            continue;
          }
          // Same backoff indexing as the normal retry path: the first blocked
          // retry waits 30s instead of being immediately reselectable (0s).
          const backoffIdx = Math.min(attempts, RETRY_BACKOFF.length - 1);
          const retryDelay = RETRY_BACKOFF[backoffIdx];
          await pool.query(
            `UPDATE konektag.outbox_events SET
               attempts = attempts + 1,
               error_message = $2,
               blocked_reason = $3,
               next_retry_at = now() + make_interval(secs := $4)
             WHERE id = $1`,
            [event.id, errMsg, 'blocked_retry', retryDelay],
          );
          metrics.blockedCount++;
          logEvent('blocked', event, Date.now() - startTime, errMsg, attempts);
          continue;
        }

        if (attempts >= MAX_RETRY_ATTEMPTS) {
          metrics.deadLettersPerReason[errMsg] = (metrics.deadLettersPerReason[errMsg] || 0) + 1;
          await deadLetter(event, errMsg, attempts);
          metrics.deadLetterCount++;
          logEvent('dead_letter', event, Date.now() - startTime, errMsg, attempts);
        } else {
          const backoffSec = RETRY_BACKOFF[Math.min(attempts, RETRY_BACKOFF.length - 1)];
          await pool.query(
            `UPDATE konektag.outbox_events SET
               attempts = attempts + 1,
               error_message = $2,
               next_retry_at = now() + make_interval(secs := $3)
             WHERE id = $1`,
            [event.id, errMsg, backoffSec],
          );
          metrics.retryCount++;
          logEvent('retry', event, Date.now() - startTime, errMsg, attempts);
        }

        // Track failures for per-minute rate
        metrics._failureTimestamps.push(Date.now());
        metrics.externalCallFailures++;
      }
    }

    // Calculate mean/max projection time
    if (processedCount > 0) {
      metrics.meanProjectionTime = Math.round(totalDuration / processedCount);
      metrics.maxProjectionTime = maxDuration;
    }

    // Prune failure timestamps older than 60s
    const now = Date.now();
    metrics._failureTimestamps = metrics._failureTimestamps.filter(t => now - t < 60000);
    metrics.projectionFailuresPerMinute = metrics._failureTimestamps.length;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Outbox] processPending error:', (error as Error).message);
  } finally {
    client.release();
  }

  // Load oldest pending age for metrics
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) AS age
       FROM konektag.outbox_events
       WHERE processed_at IS NULL AND dead_lettered_at IS NULL`,
    );
    metrics.oldestPendingAge = rows[0]?.age ? Math.round(rows[0].age) : 0;
  } catch { /* ignore */ }
}

function isBlockedError(msg: string): boolean {
  return msg.startsWith('blocked_');
}

async function deadLetter(event: any, errorMessage: string, attempts: number): Promise<void> {
  // Idempotent: at most one dead-letter record per original event, even if the
  // terminal update below failed on a previous pass and the event is reclassified.
  await pool.query(
    `INSERT INTO konektag.outbox_dead_letters
     (original_event_id, event_type, aggregate_type, aggregate_ref, payload,
      failure_reason, attempt_count, first_failed_at, last_failed_at, dead_lettered_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,now(),now()
     WHERE NOT EXISTS (
       SELECT 1 FROM konektag.outbox_dead_letters WHERE original_event_id = $1
     )`,
    [
      event.id, event.event_type, event.aggregate_type,
      event.aggregate_ref ?? event.aggregate_id,
      JSON.stringify(event.payload), errorMessage, attempts,
      event.blocked_at || event.created_at,
    ],
  );

  await pool.query(
    `UPDATE konektag.outbox_events SET
       processed_at = now(),
       dead_lettered_at = now(),
       attempts = $2,
       error_message = $3
     WHERE id = $1`,
    [event.id, attempts, errorMessage],
  );
}

interface LogEntry {
  timestamp: string;
  level: string;
  eventId: string;
  eventType: string;
  aggregateRef: string;
  durationMs: number;
  attempt?: number;
  error?: string;
  correlationId?: string;
  operationId?: string;
}

function logEvent(
  status: string,
  event: any,
  durationMs: number,
  error?: string,
  attempt?: number,
) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: error ? 'error' : 'info',
    eventId: event.id,
    eventType: event.event_type,
    aggregateRef: event.aggregate_ref || event.aggregate_id,
    durationMs,
    attempt,
    error,
    correlationId: event.correlation_id,
  };

  if (error) {
    console.error('[outbox]', JSON.stringify(entry));
  } else {
    console.log('[outbox]', JSON.stringify(entry));
  }
}

async function dispatch(event: any): Promise<void> {
  if (isFrappeProjectionEvent(event.event_type)) {
    const occurredAt = new Date(event.created_at).toISOString();
    const aggregateId = event.aggregate_id ?? event.aggregate_ref;
    const operationPrefix = event.event_type.startsWith('MERCHANT_SETTLEMENT_') ? 'SETTLEMENT' : 'CLEARING';
    if (typeof aggregateId !== 'string' || !aggregateId || Number.isNaN(Date.parse(occurredAt))) {
      throw new Error('FRAPPE_INTEGRATION_EVENT_INVALID');
    }
    await dispatchFrappeProjectionEvent({
      event_id: event.id,
      event_type: event.event_type,
      event_version: 1,
      operation_id: event.event_type === 'MERCHANT_SALE_CREATED'
        ? String(event.payload?.SourceReference || aggregateId)
        : `${operationPrefix}-${aggregateId}`,
      occurred_at: occurredAt,
      payload: event.payload,
    });
    return;
  }

  switch (event.event_type) {
    case 'DigitalAuditRequested': {
      // A03: the public form has already committed the demand. Deliver only
      // the add-only Mautic tag; absent contacts are not created and are fine.
      const email = event.payload?.email;
      if (typeof email !== 'string' || !email.includes('@') || email.length > 254) {
        throw new PermanentOutboxError('MAUTIC_AUDIT_EMAIL_INVALID');
      }
      const { mauticAdapter } = await import('../infrastructure/adapters/mautic-adapter.ts');
      await mauticAdapter.markAuditRequestedByEmail(email);
      break;
    }
    case 'MerchantCashReceiptRequested':
      if (typeof event.payload?.receiptId !== 'string') throw new Error('CASH_RECEIPT_EVENT_INVALID');
      await deliverCashReceipt(event.payload.receiptId);
      break;

    case 'UserRegistered':
      try {
        // Residence country recorded at registration routes the Contact to its Konektag site.
        const { erpnextContactService } = await import('./services/erpnext-contact-service.ts');
        await erpnextContactService.projectRegistration(event.payload.userId, event.payload.legalCountry);
      } catch (syncError) {
        const code = (syncError as { code?: string }).code ?? (syncError as Error).message;
        console.error(`[Outbox] ERPNext contact sync failed for user ${event.payload.userId}:`, code);
      }
      try {
        await mauticContactSyncService.syncUser(
          event.payload.userId,
          event.payload.keycloakId,
        );
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for user ${event.payload.userId}:`, (syncError as Error).message);
      }
      break;

    case 'KycSubmitted':
      processKycOrder(event.payload.kycOrderId).catch(err =>
        console.error(`[outbox] KYC processor error for order ${event.payload.kycOrderId}:`, err)
      );
      break;

    case 'KycPendingReview':
      await sendUserEmail(event.payload.userId, 'kyc_pending_review', 'fr', {});
      break;

    case 'KycVerified': {
      // Same authoritative identity contract as KycRejected: payload.userId is
      // the internal konektag.users.id; Keycloak requires users.keycloak_id.
      const recipient = await resolveOutboxRecipient(event.payload?.userId);
      await keycloakForDispatch.updateUserAttributes(requireRecipientKeycloakId(recipient), {
        kyc_status: 'verified',
      });
      // Non-idempotent notification runs last so a transient Keycloak retry
      // never duplicates it.
      await sendUserEmail(recipient.id, 'kyc_verified', 'fr', {});
      break;
    }

    case 'KycRejected': {
      // Authoritative identity contract: payload.userId is the internal
      // konektag.users.id produced from kyc_orders.user_id. An absent or
      // malformed reference is a permanent failure, never retried.
      const recipient = await resolveOutboxRecipient(event.payload?.userId);
      await keycloakForDispatch.updateUserAttributes(recipient.keycloak_id, {
        kyc_status: 'rejected',
      });
      // The email is the only non-idempotent side effect: it runs last, after
      // the idempotent projections succeeded, so a retryable failure never
      // duplicates the notification.
      await sendUserEmail(recipient.id, 'kyc_rejected', 'fr', {
        reason: event.payload.reason || '',
      });
      break;
    }

    case 'OnboardingCompleted': {
      // Same authoritative identity contract: resolve the internal user once
      // and address Keycloak with users.keycloak_id, never the internal UUID.
      const recipient = await resolveOutboxRecipient(event.payload?.userId);
      await keycloakForDispatch.updateUserAttributes(requireRecipientKeycloakId(recipient), {
        onboarding_state: 'COMPLETED',
      });
      break;
    }

    case 'UserProfileUpdated':
      try {
        await mauticContactSyncService.syncUser(
          event.payload.userId,
          event.payload.keycloakId,
        );
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for UserProfileUpdated ${event.payload.userId}:`, (syncError as Error).message);
      }
      break;

    case 'MarketingConsentChanged':
      try {
        await mauticContactSyncService.syncMarketingConsent(
          event.payload.userId,
          event.payload.keycloakId,
          event.payload.optIn,
        );
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for MarketingConsentChanged ${event.payload.userId}:`, (syncError as Error).message);
      }
      break;

    case 'UserMarketingProfileUpdated':
      try {
        await mauticMarketingSyncService.syncProfile(event.payload);
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for UserMarketingProfileUpdated ${event.payload.userId}:`, (syncError as Error).message);
      }
      break;

    case 'MerchantClaimApproved':
      try {
        await mauticCompanySyncService.syncCompany(event.payload.merchantId);
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for MerchantClaimApproved ${event.payload.merchantId}:`, (syncError as Error).message);
      }
      break;

    case 'MerchantMembershipAdded':
      try {
        await mauticCompanySyncService.syncCompany(event.payload.merchantId);
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for MerchantMembershipAdded ${event.payload.merchantId}:`, (syncError as Error).message);
      }
      break;

    case 'MerchantMembershipRemoved':
      try {
        await mauticCompanySyncService.removeContactFromCompany(
          event.payload.keycloakId,
          event.payload.merchantId,
        );
      } catch (syncError) {
        console.error(`[Outbox] Mautic sync failed for MerchantMembershipRemoved ${event.payload.keycloakId}:`, (syncError as Error).message);
      }
      break;

    // ── Recharge projections ──
    case 'RechargeCreated':
    case 'RechargeConfirmed':
    case 'RechargeProviderReceived':
    case 'RechargeFailed':
    case 'RechargeReversed':
    case 'RechargeProjectionRequested':
      await rechargeProjection.projectEvent(event.event_type, event.payload, event.id);
      break;

    case 'AcquisitionProcessed': {
      const { erpnextRegulatoryProjectionService } = await import('./services/erpnext-regulatory-projection-service.ts');
      await erpnextRegulatoryProjectionService.projectAcquisition(event.payload.userId, event.payload);
      break;
    }

    case 'PointsMerchantBonusProjectionRequested':
    case 'PointsMerchantRefundProjectionRequested':
    case 'PointsMerchantBonusReversalRequested':
    case 'KonektagRevenueProjectionRequested': {
      const { merchantAccountingProjectionService: accounting } = await import('./services/merchant-accounting-projection-service.ts');
      if (event.event_type==='KonektagRevenueProjectionRequested') await accounting.projectAttribution(event.payload.attributionId);
      else if (event.event_type==='PointsMerchantRefundProjectionRequested') await accounting.projectRefund(event.payload.refundId);
      else if (event.event_type==='PointsMerchantBonusReversalRequested') await accounting.projectBonusCancellation(event.payload.consumptionId);
      else await accounting.projectBonus(event.payload.consumptionId);
      break;
    }

    case 'AccountAccessChanged': {
      try {
        await keycloakForDispatch.setUserEnabled(event.payload.keycloakId, event.payload.status !== 'BLOCKED');
        await pool.query(
          `UPDATE konektag.account_access_actions SET keycloak_status = 'DONE', keycloak_error = NULL, completed_at = now(), updated_at = now()
           WHERE id = $1`, [event.payload.actionId],
        );
        const { erpnextRegulatoryProjectionService } = await import('./services/erpnext-regulatory-projection-service.ts');
        await erpnextRegulatoryProjectionService.projectAccess(event.payload.userId, event.payload);
      } catch (error) {
        await pool.query(
          `UPDATE konektag.account_access_actions SET keycloak_status = 'PENDING', keycloak_error = $2,
           retry_count = retry_count + 1, next_retry_at = now() + interval '5 minutes', updated_at = now() WHERE id = $1`,
          [event.payload.actionId, (error as Error).message],
        );
        throw error;
      }
      break;
    }

    default: throw new Error(`OUTBOX_EVENT_TYPE_UNSUPPORTED:${event.event_type}`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the authoritative recipient of a user-scoped outbox event.
 *
 * The payload contract carries the internal konektag user id
 * (konektag.users.id). Resolution is exact and authoritative only: no
 * fallback on email, username, or any other non-authoritative field.
 * A missing, malformed, or unresolvable reference is a permanent
 * failure — no retry can make such an event deliverable.
 *
 * Only the identifiers needed for delivery are selected; no personal
 * data is read here, and failure reasons carry no personal data.
 */
async function resolveOutboxRecipient(userId: unknown): Promise<{ id: string; keycloak_id: string }> {
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
    throw new PermanentOutboxError(OUTBOX_RECIPIENT_INVALID);
  }
  const { rows } = await pool.query(
    `SELECT id, keycloak_id FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (rows.length === 0) {
    throw new PermanentOutboxError(OUTBOX_RECIPIENT_NOT_FOUND);
  }
  return rows[0];
}

/**
 * Return the recipient's authoritative Keycloak identifier for adapter
 * calls whose contract requires it. A missing or structurally unusable
 * keycloak_id is a permanent failure: the internal user UUID must never
 * be substituted, and no email/name fallback may be attempted.
 */
function requireRecipientKeycloakId(recipient: { id: string; keycloak_id: string }): string {
  if (typeof recipient.keycloak_id !== 'string' || !UUID_PATTERN.test(recipient.keycloak_id)) {
    throw new PermanentOutboxError(OUTBOX_KEYCLOAK_ID_MISSING);
  }
  return recipient.keycloak_id;
}

async function getUserEmail(userId: string): Promise<{ email: string; firstName: string } | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_data FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (rows.length === 0) return null;
  const decrypted = JSON.parse(encryptionService.decrypt(rows[0].encrypted_data));
  if (!decrypted.email) return null;
  return { email: decrypted.email, firstName: decrypted.firstName || '' };
}

async function sendUserEmail(
  userId: string,
  template: 'welcome' | 'kyc_pending_review' | 'kyc_verified' | 'kyc_rejected',
  locale: string,
  extraVars: Record<string, string>,
): Promise<void> {
  try {
    const user = await getUserEmail(userId);
    if (!user) {
      console.error(`[outbox] User ${userId} not found or no email`);
      return;
    }
    const lang = locale === 'en' ? 'en' : 'fr';
    await emailService.sendTemplate(template, lang, user.email, {
      firstName: user.firstName,
      ...extraVars,
      currentYear: new Date().getFullYear().toString(),
    });
  } catch (err: any) {
    console.error(`[outbox] Failed to send ${template} email for user ${userId}:`, err.message);
  }
}

