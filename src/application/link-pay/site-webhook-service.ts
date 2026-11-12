import { createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';
import {
  MAX_DELIVERY_ATTEMPTS, RESPONSE_BODY_LIMIT, RETRY_DELAYS_SECONDS, resolveWebhookTarget, sendWebhook,
} from '../services/pay/api-payment-webhook-service.ts';
import { siteWebhook } from './frappe-site-routing.ts';

/** Signed, retryable merchant accounting integration. ERP delivery never defines payment status.
 * event_key and (transaction, site) make enqueueing and worker retries idempotent.
 */

type Db = Pick<PoolClient, 'query'>;
export const LINK_PAY_EVENT = 'link_pay.payment.succeeded';

interface Delivery {
  id: string; transaction_id: string; target_site: string; roles: string[]; payload: any;
  attempts: number; processing_lease_id: string;
}

export function sitePayload(transaction: any, link: any, slug: string, roles: string[]) {
  return {
    event: LINK_PAY_EVENT, roles,
    transactionId: transaction.id, operationId: transaction.k_operation_id, linkId: slug,
    paidAt: new Date(transaction.paid_at).toISOString(),
    invoice: link.invoice, invoiceCompany: link.invoice_company,
    issuerSite: link.issuer_site, beneficiarySite: link.beneficiary_site, networkSite: link.network_site,
    beneficiaryName: link.beneficiary_name, thirdParty: link.beneficiary_site !== link.network_site,
    currency: transaction.currency, quantityK: Number(transaction.quantity_k),
    // Minor units of the currency.
    grossAmount: Number(transaction.gross_minor), feeAmount: Number(transaction.fee_minor), netAmount: Number(transaction.net_minor),
    fee: { mode: link.fee_mode, rateBps: Number(link.fee_rate_bps) },
  };
}

/** In the payment transaction. */
export async function enqueueSiteWebhooks(db: Db, input: { transaction: any; link: any; slug: string }) {
  const { transaction, link, slug } = input;
  const { rows: [delivery] } = await db.query(
    `INSERT INTO konektag.link_pay_site_webhooks (transaction_id, target_site, roles, event_key, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (event_key) DO UPDATE SET updated_at = now() RETURNING id`,
    [transaction.id, link.beneficiary_site, ['beneficiary'], `link-pay:${transaction.id}:${link.beneficiary_site}`, LINK_PAY_EVENT,
     JSON.stringify(sitePayload(transaction, link, slug, ['beneficiary']))]);
  return delivery.id as string;
}

/** The site must confirm the transaction and answer for every role it received. */
export function acknowledged(delivery: Pick<Delivery, 'transaction_id' | 'roles'>, body: string | null) {
  let data: any;
  try { data = JSON.parse(body || ''); } catch { return false; }
  const ack = data?.message ?? data;
  return ack?.transactionId === delivery.transaction_id
    && delivery.roles.every(role => typeof ack?.[role] === 'string' && ack[role].length > 0);
}

async function markFailed(delivery: Delivery, error: string, status?: number, body?: string | null) {
  const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  const delay = RETRY_DELAYS_SECONDS[delivery.attempts] ?? RETRY_DELAYS_SECONDS.at(-1)!;
  await pool.query(
    `UPDATE konektag.link_pay_site_webhooks
     SET status = $2::text, response_status = COALESCE($3, response_status), response_body = COALESCE($4, response_body),
         last_error = $5, next_attempt_at = CASE WHEN $2::text = 'dead_lettered' THEN NULL ELSE now() + make_interval(secs := $6) END,
         processing_started_at = NULL, processing_lease_id = NULL, updated_at = now()
     WHERE id = $1 AND status = 'processing' AND processing_lease_id = $7`,
    [delivery.id, terminal ? 'dead_lettered' : 'failed', status ?? null, body ?? null,
     error.slice(0, RESPONSE_BODY_LIMIT), delay, delivery.processing_lease_id]);
}

async function deliverClaimed(delivery: Delivery, env: NodeJS.ProcessEnv): Promise<string[]> {
  const site = siteWebhook(delivery.target_site, env);
  if (!site) { await markFailed(delivery, 'SITE_WEBHOOK_NOT_CONFIGURED'); return []; }
  let response: { status: number; body: string | null };
  try {
    const target = await resolveWebhookTarget(site.url);
    const raw = JSON.stringify(delivery.payload);
    response = await sendWebhook(target, {
      'Content-Type': 'application/json',
      'X-Konektag-Signature': createHmac('sha256', site.secret).update(raw).digest('hex'),
      'X-Konektag-Event': LINK_PAY_EVENT,
      'X-Konektag-Delivery': delivery.id,
    }, raw);
  } catch (error) {
    await markFailed(delivery, error instanceof Error ? error.message : 'Webhook delivery failed');
    return [];
  }
  if (response.status < 200 || response.status >= 300) {
    await markFailed(delivery, `Webhook returned HTTP ${response.status}`, response.status, response.body);
    return [];
  }
  if (!acknowledged(delivery, response.body)) {
    await markFailed(delivery, 'WEBHOOK_NOT_ACKNOWLEDGED', response.status, response.body);
    return [];
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE konektag.link_pay_site_webhooks
       SET status = 'delivered', response_status = $2, response_body = $3, delivered_at = now(), next_attempt_at = NULL,
           processing_started_at = NULL, processing_lease_id = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND processing_lease_id = $4`,
      [delivery.id, response.status, response.body, delivery.processing_lease_id]);
    await client.query('COMMIT');
    return [];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const CLAIMED = `RETURNING d.id, d.transaction_id, d.target_site, d.roles, d.payload, d.attempts, d.processing_lease_id`;

export const siteWebhookService = {
  /** Deliver merchant integration; failures are retried without touching the ledger. */
  async deliver(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    let next = [id];
    while (next.length) {
      const released: string[] = [];
      for (const deliveryId of next) {
        try {
          const { rows: [claimed] } = await pool.query<Delivery>(
            `UPDATE konektag.link_pay_site_webhooks d
             SET status = 'processing', attempts = d.attempts + 1, attempted_at = now(), processing_started_at = now(),
                 processing_lease_id = $3, last_error = NULL, updated_at = now()
             WHERE d.id = $1 AND d.attempts < $2
               AND (d.status = 'pending' OR (d.status = 'failed' AND d.next_attempt_at <= now())) ${CLAIMED}`,
            [deliveryId, MAX_DELIVERY_ATTEMPTS, randomUUID()]);
          if (claimed) released.push(...await deliverClaimed(claimed, env));
        } catch (error) {
          console.error('[link-pay-site-webhook] delivery failed', (error as Error).message);
        }
      }
      next = released;
    }
  },

  /** Worker pass: due and stale deliveries; a blocked delivery is never sent before its network. */
  async processDue(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
      await pool.query(
        `UPDATE konektag.link_pay_site_webhooks
         SET status = 'dead_lettered', next_attempt_at = NULL,
             last_error = COALESCE(last_error, 'Webhook delivery lease expired after maximum attempts'),
             processing_started_at = NULL, processing_lease_id = NULL, updated_at = now()
         WHERE status = 'processing' AND attempts >= $1 AND processing_started_at < now() - interval '10 minutes'`,
        [MAX_DELIVERY_ATTEMPTS]);
      const { rows } = await pool.query<Delivery>(
        `WITH due AS (
           SELECT id FROM konektag.link_pay_site_webhooks
           WHERE attempts < $1 AND (
             (status IN ('pending', 'failed') AND COALESCE(next_attempt_at, created_at) <= now())
             OR (status = 'processing' AND processing_started_at < now() - interval '10 minutes'))
           ORDER BY COALESCE(next_attempt_at, created_at), id LIMIT 50 FOR UPDATE SKIP LOCKED)
         UPDATE konektag.link_pay_site_webhooks d
         SET status = 'processing', attempts = d.attempts + 1, attempted_at = now(), processing_started_at = now(),
             processing_lease_id = $2, last_error = NULL, updated_at = now()
         FROM due WHERE d.id = due.id ${CLAIMED}`,
        [MAX_DELIVERY_ATTEMPTS, randomUUID()]);
      const released = (await Promise.all(rows.map(delivery => deliverClaimed(delivery, env).catch(() => [])))).flat();
      for (const id of released) await this.deliver(id, env);
    } catch (error) {
      console.error('[link-pay-site-webhook] Unable to process due deliveries', (error as Error).message);
    }
  },

  /**
   * A site asks again for its own dead-lettered or failed deliveries (after an outage).
   * Attempts restart; the event, payload and ordering are unchanged.
   */
  async redeliver(site: string, transactionId: string) {
    const { rows } = await pool.query(
      `UPDATE konektag.link_pay_site_webhooks
       SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
       WHERE target_site = $1 AND transaction_id = $2 AND status IN ('dead_lettered', 'failed') RETURNING id`,
      [site, transactionId]);
    for (const row of rows) await this.deliver(row.id);
    return rows.length;
  },

  async status(site: string, transactionId: string) {
    const { rows } = await pool.query(
      `SELECT target_site, roles, status, attempts, last_error, delivered_at FROM konektag.link_pay_site_webhooks
       WHERE transaction_id = $1 AND (target_site = $2 OR transaction_id IN (
         SELECT id FROM konektag.link_pay_network_transactions WHERE network_site = $2))
       ORDER BY created_at`, [transactionId, site]);
    return rows;
  },
};
