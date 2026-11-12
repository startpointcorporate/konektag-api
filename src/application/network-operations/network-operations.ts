/**
 * Network (Réseau) follow-up of operations, from their issuance, pending payment included.
 *
 * Each notification is an outbox event (NetworkOperationChanged) written in the transaction that
 * changes the operation; the outbox worker sends it to the Frappe site of the Network team with that
 * site's service account (konektag_360.network_operations.record), with the existing retries.
 * - Link Pay network processing is API-owned. Historical queued Link Pay projections are retired
 *   without an ERP call; current links and payment facts stay in the API tables.
 * - Points K recharge (Stripe, PawaPay): pending when the provider accepted the request and gave its
 *   reference, then paid or failed from the verified webhook or the PawaPay reconciliation, on the
 *   Konektag site of the buyer's residence country (order_metadata.konektagSite).
 * aggregate_ref = event key, unique (migration 232): a replay queues nothing; Frappe applies each
 * event once and never moves a final status back to pending.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';
import { frappeSite } from '../marketplace-transactions/frappe-site.ts';

type Db = Pick<PoolClient, 'query'>;
export const NETWORK_OPERATION_EVENT = 'NetworkOperationChanged';
export type OperationStatus = 'pending' | 'paid' | 'failed' | 'expired';

export interface NetworkOperation {
  key: string;
  type: 'link_pay' | 'points_k_recharge';
  status: OperationStatus;
  eventKey: string;
  reference: string;
  issuedAt?: string;
  /** Deadline of a Link Pay link. */
  expiresAt?: string;
  settledAt?: string;
  currency?: string;
  /** Minor units of the currency. */
  amount?: number;
  quantityK?: number;
  provider?: 'points_k' | 'stripe' | 'pawapay';
  providerReference?: string;
  orderId?: string;
  failureReason?: string;
  beneficiarySite?: string;
  beneficiaryName?: string;
  issuerSite?: string;
  invoice?: string;
}

const RESULTS = new Set(['recorded', 'updated', 'already_recorded', 'stale', 'conflict']);
const SITE_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;

export async function enqueueNetworkOperation(db: Db, input: { site: string; aggregateId: string; operation: NetworkOperation }) {
  if (!SITE_KEY.test(input.site)) throw new Error('NETWORK_OPERATION_SITE_INVALID');
  await db.query(
    `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
     VALUES ($1, 'NetworkOperation', $2, $3, $4, 1, $5::jsonb)
     ON CONFLICT (aggregate_ref) WHERE event_type = 'NetworkOperationChanged' DO NOTHING`,
    [randomUUID(), input.aggregateId, input.operation.eventKey, NETWORK_OPERATION_EVENT,
     JSON.stringify({ site: input.site, operation: input.operation })]);
}

/**
 * Recharge notification for a provider attempt of a routed Points K purchase. Other attempts (API
 * checkouts of merchants, purchases without a Konektag site) have no Network operation.
 */
export async function enqueueRechargeOperation(db: Db, input: {
  provider: 'stripe' | 'pawapay'; providerReference: string; status: OperationStatus; failureReason?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const { rows: [row] } = await db.query(
    `SELECT a.id AS attempt_id, a.provider_reference, a.expected_amount, a.expected_currency, a.created_at,
            o.id AS order_id, o.order_metadata->'konektagSite'->>'slug' AS slug
     FROM konektag.payment_provider_attempts a
     JOIN konektag.api_payment_orders o ON a.source_type = 'api_payment' AND o.id::text = a.source_id::text
     WHERE a.provider = $1 AND a.provider_reference = $2 AND o.order_purpose = 'wallet_recharge'`,
    [input.provider, input.providerReference]);
  if (!row?.slug) return false;
  const site = resolveSlugSite(row.slug, input.env ?? process.env);
  if (!site) {
    console.error('[network-operations] no Frappe site for the recharge slug', { slug: row.slug, attemptId: row.attempt_id });
    return false;
  }
  const now = new Date().toISOString();
  await enqueueNetworkOperation(db, {
    site, aggregateId: row.attempt_id,
    operation: {
      key: `recharge:${row.attempt_id}`, type: 'points_k_recharge', status: input.status,
      eventKey: `recharge:${row.attempt_id}:${input.status}`, reference: row.attempt_id,
      issuedAt: new Date(row.created_at).toISOString(), ...(input.status === 'pending' ? {} : { settledAt: now }),
      currency: row.expected_currency, amount: Number(row.expected_amount), provider: input.provider,
      providerReference: row.provider_reference, orderId: row.order_id,
      ...(input.status === 'failed' && input.failureReason ? { failureReason: String(input.failureReason).slice(0, 140) } : {}),
    },
  });
  return true;
}

/** Outbox handler: one call to the Network site; any failure is retried by the outbox. */
export async function deliverNetworkOperation(payload: any, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const site = payload?.site;
  const operation = payload?.operation as NetworkOperation | undefined;
  if (typeof site !== 'string' || !SITE_KEY.test(site) || !operation?.key || !operation.eventKey)
    throw new Error('NETWORK_OPERATION_PAYLOAD_INVALID');
  // Historical Link Pay outbox messages are API-owned: retire them without network ERP calls.
  if (operation.type === 'link_pay') return 'api_owned';
  const result = await frappeSite(site, env, fetchImpl).call('konektag_360.network_operations.record', { operation });
  if (result?.key !== operation.key || !RESULTS.has(result?.result)) throw new Error('NETWORK_OPERATION_NOT_ACKNOWLEDGED');
  return result.result as string;
}
