import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import pool from '../../../infrastructure/database/pool.ts';
import { MerchantProSubscriptionService } from '../merchant-pro-subscription-service.ts';

export type ApiPaymentWebhookEnvironment = 'sandbox' | 'live';
export type ApiPaymentWebhookEvent =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'payment.expired'
  | 'payment.refunded';

export interface PaymentWebhookOrder {
  id: string;
  merchant_profile_id: string;
  environment: ApiPaymentWebhookEnvironment;
  merchant_transaction_id: string;
  total_amount: number;
  fee_amount: number;
  currency: string;
  paid_at: string | Date | null;
}

interface EndpointRow {
  id: string;
  environment: ApiPaymentWebhookEnvironment;
  webhook_url: string | null;
  signing_secret: string | null;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  merchant_profile_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  webhook_url: string;
  signing_secret: string;
  processing_lease_id: string;
}

type DatabaseClient = {
  query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

export class ApiPaymentWebhookValidationError extends Error {}

const ENVIRONMENTS: ApiPaymentWebhookEnvironment[] = ['sandbox', 'live'];
export const RESPONSE_BODY_LIMIT = 4_000;
export const MAX_DELIVERY_ATTEMPTS = 7;
export const RETRY_DELAYS_SECONDS = [0, 60, 300, 1_800, 7_200, 21_600, 86_400];

function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 0 || first === 10 || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (family === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(host)) return true;
    const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mappedIpv4 ? isPrivateAddress(mappedIpv4[1]) : false;
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

export type ResolvedWebhookTarget = {
  url: URL;
  address?: string;
  family?: 4 | 6;
};

export async function resolveWebhookTarget(
  value: string,
  development = process.env.NODE_ENV === 'development',
  resolver: typeof lookup = lookup,
): Promise<ResolvedWebhookTarget> {
  if (!value.trim() || value.length > 2_048) throw new ApiPaymentWebhookValidationError('Webhook URL is invalid');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiPaymentWebhookValidationError('Webhook URL is invalid');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.username || url.password) throw new ApiPaymentWebhookValidationError('Webhook URL must not include user credentials');
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && hostname === 'localhost')) {
    throw new ApiPaymentWebhookValidationError('Webhook URL must use HTTPS');
  }
  if (!development && (isPrivateHostname(hostname) || isPrivateAddress(hostname))) {
    throw new ApiPaymentWebhookValidationError('Webhook URL host is not allowed');
  }

  if (!development && !isIP(hostname)) {
    let addresses;
    try {
      addresses = await resolver(hostname, { all: true, verbatim: true });
    } catch {
      throw new ApiPaymentWebhookValidationError('Webhook URL host cannot be resolved');
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new ApiPaymentWebhookValidationError('Webhook URL host is not allowed');
    }
    const { address, family } = addresses[0];
    return { url, address, family: family as 4 | 6 };
  }

  return { url, ...(isIP(hostname) ? { address: hostname, family: isIP(hostname) as 4 | 6 } : {}) };
}

export async function validateWebhookUrl(value: string, development = process.env.NODE_ENV === 'development'): Promise<string> {
  return (await resolveWebhookTarget(value, development)).url.toString();
}

function publicEndpoint(endpoint: Pick<EndpointRow, 'environment' | 'webhook_url' | 'signing_secret'>) {
  return {
    environment: endpoint.environment,
    url: endpoint.webhook_url,
    secretExists: Boolean(endpoint.signing_secret),
  };
}

function paymentSucceededPayload(order: PaymentWebhookOrder) {
  if (!order.paid_at) throw new Error('Paid payment order is missing paid_at');
  const paidAt = new Date(order.paid_at);
  if (Number.isNaN(paidAt.getTime())) throw new Error('Paid payment order has an invalid paid_at');
  const transactionDate = paidAt.toISOString();
  return {
    transactionId: order.merchant_transaction_id,
    transactionDate,
    paymentId: order.id,
    paymentAmount: order.total_amount,
    paymentFees: order.fee_amount,
    currency: order.currency,
    event: 'payment.succeeded' as const,
    environment: order.environment,
  };
}

function paymentEventPayload(order: PaymentWebhookOrder, event: ApiPaymentWebhookEvent) {
  if (event === 'payment.succeeded') return paymentSucceededPayload(order);
  return {
    transactionId: order.merchant_transaction_id,
    transactionDate: new Date(order.paid_at || Date.now()).toISOString(),
    paymentId: order.id,
    paymentAmount: order.total_amount,
    paymentFees: order.fee_amount,
    currency: order.currency,
    event,
    environment: order.environment,
  };
}

export async function sendWebhook(target: ResolvedWebhookTarget, headers: Record<string, string>, rawPayload: string): Promise<{ status: number; body: string | null }> {
  const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      headers,
      timeout: 5_000,
      ...(target.address ? {
        // Keep hostname for TLS SNI and Host, but never resolve it a second time.
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [{ address: target.address!, family: target.family! }]);
          } else {
            callback(null, target.address!, target.family!);
          }
        },
      } : {}),
    };
    const outgoing = request(requestOptions, (incoming) => {
      const chunks: Buffer[] = [];
      let length = 0;
      incoming.on('data', (chunk: Buffer) => {
        if (length < RESPONSE_BODY_LIMIT) {
          const remaining = RESPONSE_BODY_LIMIT - length;
          chunks.push(chunk.subarray(0, remaining));
          length += Math.min(chunk.length, remaining);
        }
      });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      incoming.on('error', reject);
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('Webhook delivery timed out')));
    outgoing.on('error', reject);
    outgoing.end(rawPayload);
  });
}

async function markFailed(delivery: DeliveryRow, error: string, responseStatus?: number, body?: string | null): Promise<void> {
  const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  const delay = RETRY_DELAYS_SECONDS[delivery.attempts] ?? RETRY_DELAYS_SECONDS.at(-1)!;
  await pool.query(
    `UPDATE konektag.api_payment_webhook_deliveries
     SET status = $2::text, response_status = COALESCE($3, response_status), response_body = COALESCE($4, response_body),
          last_error = $5, next_attempt_at = CASE WHEN $2::text = 'dead_lettered' THEN NULL ELSE now() + make_interval(secs := $6) END,
          processing_started_at = NULL, processing_lease_id = NULL, updated_at = now()
     WHERE id = $1 AND status = 'processing' AND processing_lease_id = $7`,
    [delivery.id, terminal ? 'dead_lettered' : 'failed', responseStatus ?? null, body ?? null,
       error.slice(0, RESPONSE_BODY_LIMIT), delay, delivery.processing_lease_id],
  );
}

async function deliverClaimed(delivery: DeliveryRow): Promise<void> {
  const { state } = delivery.merchant_profile_id
    ? await new MerchantProSubscriptionService(pool).resolveSubscription(delivery.merchant_profile_id)
    : { state: 'ABSENT' };
  if (state !== 'ACTIVE') {
    await pool.query(
      `UPDATE konektag.api_payment_webhook_deliveries
       SET status='dead_lettered', last_error='PRO_SUBSCRIPTION_INACTIVE', next_attempt_at=NULL,
           processing_started_at=NULL, processing_lease_id=NULL, updated_at=now()
       WHERE id=$1 AND status='processing' AND processing_lease_id=$2`,
      [delivery.id, delivery.processing_lease_id],
    );
    return;
  }
  let response: { status: number; body: string | null };
  let body: string | null = null;
  try {
    const target = await resolveWebhookTarget(delivery.webhook_url);
    const rawPayload = JSON.stringify(delivery.payload);
    const signature = createHmac('sha256', delivery.signing_secret).update(rawPayload).digest('hex');
    response = await sendWebhook(target, {
        'Content-Type': 'application/json',
        'X-Konektag-Signature': signature,
        'X-Konektag-Event': delivery.event_type,
      }, rawPayload);
    body = response.body;
  } catch (error) {
    await markFailed(delivery, error instanceof Error ? error.message : 'Webhook delivery failed');
    return;
  }

  if (response.status >= 200 && response.status < 300) {
    await pool.query(
      `UPDATE konektag.api_payment_webhook_deliveries
        SET status = 'delivered', response_status = $2, response_body = $3, delivered_at = now(),
            next_attempt_at = NULL, processing_started_at = NULL, processing_lease_id = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'processing' AND processing_lease_id = $4`,
       [delivery.id, response.status, body, delivery.processing_lease_id],
    );
    return;
  }
  await markFailed(delivery, `Webhook returned HTTP ${response.status}`, response.status, body);
}

export const apiPaymentWebhookService = {
  async enqueuePaymentEvent(client: DatabaseClient, order: PaymentWebhookOrder, event: ApiPaymentWebhookEvent): Promise<string | null> {
    const { state } = await new MerchantProSubscriptionService(client as any).resolveSubscription(order.merchant_profile_id);
    if (state !== 'ACTIVE') return null;
    const { rows: endpoints } = await client.query<EndpointRow>(
      `SELECT id, environment, webhook_url, signing_secret
       FROM konektag.merchant_api_webhook_endpoints
       WHERE merchant_profile_id = $1 AND environment = $2
         AND webhook_url IS NOT NULL AND signing_secret IS NOT NULL
       LIMIT 1`,
      [order.merchant_profile_id, order.environment],
    );
    const endpoint = endpoints[0];
    if (!endpoint?.webhook_url || !endpoint.signing_secret) return null;
    const payload = paymentEventPayload(order, event);
    const eventKey = `payment:${order.id}:${event}`;
    const { rows: deliveries } = await client.query<{ id: string }>(
      `INSERT INTO konektag.api_payment_webhook_deliveries
       (endpoint_id, payment_order_id, event_key, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (event_key) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [endpoint.id, order.id, eventKey, event, JSON.stringify(payload)],
    );
    return deliveries[0]?.id ?? null;
  },
  async listEndpoints(merchantProfileId: string) {
    const { rows } = await pool.query<EndpointRow>(
      `SELECT environment, webhook_url, signing_secret
       FROM konektag.merchant_api_webhook_endpoints
       WHERE merchant_profile_id = $1`,
      [merchantProfileId],
    );
    const byEnvironment = new Map<ApiPaymentWebhookEnvironment, EndpointRow>();
    rows.forEach((row: EndpointRow) => byEnvironment.set(row.environment, row));
    return ENVIRONMENTS.map((environment) => publicEndpoint(byEnvironment.get(environment) ?? {
      environment,
      webhook_url: null,
      signing_secret: null,
    }));
  },

  async updateEndpoint(merchantProfileId: string, environment: ApiPaymentWebhookEnvironment, value: string) {
    const requestedUrl = value.trim();
    if (!requestedUrl) {
      const { rows } = await pool.query<EndpointRow>(
        `UPDATE konektag.merchant_api_webhook_endpoints
         SET webhook_url = NULL, updated_at = now()
         WHERE merchant_profile_id = $1 AND environment = $2
         RETURNING environment, webhook_url, signing_secret`,
        [merchantProfileId, environment],
      );
      return publicEndpoint(rows[0] ?? { environment, webhook_url: null, signing_secret: null });
    }

    const webhookUrl = await validateWebhookUrl(requestedUrl);
    // A secret is created on first configuration and only shown in that response.
    // Later URL changes keep the existing secret until the merchant rotates it.
    const signingSecret = randomBytes(32).toString('base64url');
    const { rows } = await pool.query<EndpointRow>(
      `INSERT INTO konektag.merchant_api_webhook_endpoints
        (merchant_profile_id, environment, webhook_url, signing_secret)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (merchant_profile_id, environment) DO UPDATE
        SET webhook_url = EXCLUDED.webhook_url,
            signing_secret = COALESCE(konektag.merchant_api_webhook_endpoints.signing_secret, EXCLUDED.signing_secret),
            updated_at = now()
        RETURNING environment, webhook_url, signing_secret`,
      [merchantProfileId, environment, webhookUrl, signingSecret],
    );
    const endpoint = rows[0];
    return {
      ...publicEndpoint(endpoint),
      secret: endpoint.signing_secret === signingSecret ? signingSecret : undefined,
    };
  },

  async rotateSecret(merchantProfileId: string, environment: ApiPaymentWebhookEnvironment) {
    const signingSecret = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO konektag.merchant_api_webhook_endpoints
       (merchant_profile_id, environment, signing_secret)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_profile_id, environment) DO UPDATE
       SET signing_secret = EXCLUDED.signing_secret, updated_at = now()`,
      [merchantProfileId, environment, signingSecret],
    );
    return { environment, secret: signingSecret };
  },

  async enqueuePaymentSucceeded(client: DatabaseClient, order: PaymentWebhookOrder): Promise<string | null> {
    return this.enqueuePaymentEvent(client, order, 'payment.succeeded');
  },

  async enqueuePaymentFailed(client: DatabaseClient, order: PaymentWebhookOrder) {
    return this.enqueuePaymentEvent(client, order, 'payment.failed');
  },
  async enqueuePaymentCancelled(client: DatabaseClient, order: PaymentWebhookOrder) {
    return this.enqueuePaymentEvent(client, order, 'payment.cancelled');
  },
  async enqueuePaymentExpired(client: DatabaseClient, order: PaymentWebhookOrder) {
    return this.enqueuePaymentEvent(client, order, 'payment.expired');
  },
  async enqueuePaymentRefunded(client: DatabaseClient, order: PaymentWebhookOrder) {
    return this.enqueuePaymentEvent(client, order, 'payment.refunded');
  },

  async deliverPaymentSucceeded(id: string): Promise<void> {
    try {
      const leaseId = randomUUID();
      const { rows: claimed } = await pool.query<DeliveryRow>(
        `UPDATE konektag.api_payment_webhook_deliveries
           SET status = 'processing', attempts = attempts + 1, attempted_at = now(), processing_started_at = now(), processing_lease_id = $3,
               last_error = NULL, updated_at = now()
           WHERE id = $1 AND attempts < $2 AND (
             status = 'pending'
             OR (status = 'failed' AND next_attempt_at <= now())
           )
           RETURNING id, endpoint_id, event_type, payload, attempts, processing_lease_id,
            (SELECT webhook_url FROM konektag.merchant_api_webhook_endpoints WHERE id = endpoint_id) AS webhook_url,
            (SELECT signing_secret FROM konektag.merchant_api_webhook_endpoints WHERE id = endpoint_id) AS signing_secret,
            (SELECT merchant_profile_id FROM konektag.merchant_api_webhook_endpoints WHERE id = endpoint_id) AS merchant_profile_id`,
         [id, MAX_DELIVERY_ATTEMPTS, leaseId],
      );
      if (claimed[0]?.webhook_url && claimed[0].signing_secret) await deliverClaimed(claimed[0]);
    } catch (error) {
      console.error('[api-payment-webhook] Unable to enqueue or deliver payment webhook', error);
    }
  },

  async enqueueAndDeliverPaymentSucceeded(order: PaymentWebhookOrder): Promise<void> {
    try {
      const deliveryId = await this.enqueuePaymentSucceeded(pool, order);
      if (deliveryId) await this.deliverPaymentSucceeded(deliveryId);
    } catch (error) {
      console.error('[api-payment-webhook] Unable to enqueue or deliver payment webhook', error);
    }
  },

  async processDue(): Promise<void> {
    try {
      await pool.query(
        `UPDATE konektag.api_payment_webhook_deliveries
         SET status = 'dead_lettered', next_attempt_at = NULL,
              last_error = COALESCE(last_error, 'Webhook delivery lease expired after maximum attempts'),
              processing_started_at = NULL, processing_lease_id = NULL, updated_at = now()
         WHERE status = 'processing' AND attempts >= $1
           AND processing_started_at < now() - interval '10 minutes'`,
        [MAX_DELIVERY_ATTEMPTS],
      );
       const leaseId = randomUUID();
       const { rows: claimed } = await pool.query<DeliveryRow>(
        `WITH due AS (
           SELECT d.id
           FROM konektag.api_payment_webhook_deliveries d
           WHERE d.attempts < $1 AND (
             (d.status IN ('pending', 'failed') AND COALESCE(d.next_attempt_at, d.created_at) <= now())
             OR (d.status = 'processing' AND d.processing_started_at < now() - interval '10 minutes')
           )
           ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.id
           LIMIT 50
           FOR UPDATE SKIP LOCKED
         )
         UPDATE konektag.api_payment_webhook_deliveries d
          SET status = 'processing', attempts = d.attempts + 1, attempted_at = now(), processing_started_at = now(), processing_lease_id = $2,
              last_error = NULL, updated_at = now()
         FROM due
         WHERE d.id = due.id
          RETURNING d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.processing_lease_id,
           (SELECT webhook_url FROM konektag.merchant_api_webhook_endpoints WHERE id = d.endpoint_id) AS webhook_url,
           (SELECT signing_secret FROM konektag.merchant_api_webhook_endpoints WHERE id = d.endpoint_id) AS signing_secret,
           (SELECT merchant_profile_id FROM konektag.merchant_api_webhook_endpoints WHERE id = d.endpoint_id) AS merchant_profile_id`,
         [MAX_DELIVERY_ATTEMPTS, leaseId],
      );
      await Promise.all(claimed.map(async (delivery) => {
        if (delivery.webhook_url && delivery.signing_secret) await deliverClaimed(delivery);
        else await markFailed(delivery, 'Webhook endpoint configuration is unavailable');
      }));
    } catch (error) {
      console.error('[api-payment-webhook] Unable to process due webhook deliveries', error);
    }
  },
};
