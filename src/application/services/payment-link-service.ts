import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';
import { networkLinkService } from '../link-pay/network-link-service.ts';

/**
 * Link Pay links. The beneficiary is a Frappe site collected through its network site
 * (link-pay/network-link-service.ts); the link, its transaction and its webhooks live in the
 * network tables. Links bound to konektag.merchant_profiles are retired: none was ever issued in
 * production, and no route creates, reads or pays them any more.
 */
export const LINK_PAY_MERCHANT_PROFILE_RETIRED = 'LINK_PAY_MERCHANT_PROFILE_RETIRED';

type Db = Pick<PoolClient, 'query'>;
// Only network links (collection_route = 'frappe_network') are claimed, released or consumed.
const NETWORK = `source_type = 'payment_link' AND collection_route = 'frappe_network'`;

export const paymentLinkService = {
  /** A network link for an authenticated payer (with its frozen valuation and beneficiary). */
  async get(slug: string, db: Db = pool) {
    return networkLinkService.getBySlug(slug, db);
  },

  async claim(slug: string, client: Db = pool) {
    const { rows: [row] } = await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'PROCESSING', updated_at = now(), version = version + 1
       WHERE public_id = $1 AND ${NETWORK} AND status = 'ISSUED' AND expiration > now()
       RETURNING id`, [slug]);
    return Boolean(row);
  },

  async release(slug: string, client: Db = pool) {
    await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'ISSUED', updated_at = now(), version = version + 1
       WHERE public_id = $1 AND ${NETWORK} AND status = 'PROCESSING'`, [slug]);
  },

  async complete(slug: string, params: {
    payerUserId: string; payerIdentity?: string | null; externalTransactionId?: string | null; kOperationId: string;
  }, client: Db = pool) {
    const { rowCount } = await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'CONSUMED', payer_user_id = $1, payer_identity = $2, external_transaction_id = $3,
           k_operation_id = $5, operation_id = $5::uuid, consumed_at = now(), updated_at = now(), version = version + 1
       WHERE public_id = $4 AND ${NETWORK} AND status = 'PROCESSING'
       RETURNING id`,
      [params.payerUserId, params.payerIdentity || null, params.externalTransactionId || null, slug, params.kOperationId]);
    return Boolean(rowCount);
  },
};
