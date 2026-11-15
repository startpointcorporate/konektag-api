import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';
import { valuePointsK } from '../services/points-k-valuation-service.ts';
import { majorToMinor } from '../services/pay/money-unit.ts';
import { resolvePointsOwner } from '../services/pay/points-wallet-service.ts';
import { lockPointsOwner, reservePoints } from '../services/pay/points-reservation-service.ts';
import { consumeReservedLinkPoints } from '../services/pay/link-k-consumption-service.ts';
import { checkUserKycVerified } from '../services/user-kyc-gate-service.ts';
import { beneficiaryTerms, splitAmount, type BeneficiaryTerms, type VerifiedInvoice } from './frappe-site-routing.ts';
import { RestaurantSourceSchema, verifyRestaurantSource, releaseRestaurantSource, type RestaurantSource } from './restaurant-source.ts';
import { LinkPaySiteError } from './frappe-site-routing.ts';
import { enqueueSiteWebhooks } from './site-webhook-service.ts';

/**
 * Link Pay: merchant invoice in Frappe, network processing and ledger entirely in the API.
 * Stored in checkout_intents (collection_route = 'frappe_network', no merchant profile) so the payer
 * keeps the existing link page, resume and history; origin and frozen terms are in
 * link_pay_network_links. konektag.merchant_profiles is never read.
 */

type Db = Pick<PoolClient, 'query'>;

export function mapNetworkLink(row: any) {
  const expired = !row.expiration || new Date(row.expiration).getTime() <= Date.now();
  const status = row.status === 'CONSUMED' ? 'Used' : row.status === 'EXPIRED' || expired ? 'Expired'
    : row.status === 'ISSUED' ? 'Active' : 'Inactive';
  return {
    name: row.public_id, url_slug: row.public_id, etablissement: row.beneficiary_name,
    amount: Number(row.amount), quantityK: Number(row.quantity_k), currency: row.currency,
    description: row.service_description || '', reference: row.invoice, expires_at: row.expiration,
    status, creation: row.created_at,
    beneficiary: { site: row.beneficiary_site, name: row.beneficiary_name },
    network: { site: row.network_site },
    fee: { mode: row.fee_mode, rateBps: Number(row.fee_rate_bps) },
    origin: { site: row.issuer_site, invoice: row.invoice },
    ...(row.collection_source_type === 'restaurant_order' ? { sourceType: 'restaurant_order' as const, sourceAttempt: row.collection_source?.attempt } : {}),
  };
}

const LINK_SELECT = `SELECT ci.*, nl.* FROM konektag.checkout_intents ci
  JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id`;

export const networkLinkService = {
  /** One link per origin key; a replay of the key returns it, a different invoice or amount is refused. */
  async create(params: { site: string; originKey: string; invoice: VerifiedInvoice; terms: BeneficiaryTerms;
    description: string; expiration: Date; source?: RestaurantSource }) {
    const { invoice, terms } = params;
    if (invoice.currency !== terms.currency) throw new Error('INVOICE_CURRENCY_MISMATCH');
    const amountMinor = majorToMinor(invoice.amountMajor, terms.currency);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (params.source) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`link-pay-source:${params.site}:${params.source.attempt}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [params.originKey]);
      const { rows: [existing] } = await client.query(`${LINK_SELECT} WHERE nl.origin_key = $1`, [params.originKey]);
      if (existing) {
        await client.query('COMMIT');
        if (Number(existing.amount) !== amountMinor || existing.currency !== terms.currency || existing.invoice !== invoice.name
          || (params.source ? existing.collection_source?.attempt !== params.source.attempt
            || existing.collection_source?.posProfile !== params.source.posProfile
            || existing.collection_source?.fingerprint !== params.source.fingerprint : existing.collection_source_type !== 'invoice'))
          throw new Error('IDEMPOTENCY_KEY_REUSED');
        return mapNetworkLink(existing);
      }
      if (params.source) {
        const verified = await verifyRestaurantSource(params.site, params.source.attempt, params.source.posProfile);
        if (verified.state !== 'Prepared' || verified.source.fingerprint !== params.source.fingerprint
          || verified.invoice.amountMajor !== invoice.amountMajor || verified.invoice.currency !== invoice.currency
          || verified.invoice.name !== invoice.name || verified.expiration.getTime() <= Date.now()
          || verified.expiration.getTime() > Date.now() + 7 * 86400000
          || verified.expiration.getTime() !== params.expiration.getTime())
          throw new LinkPaySiteError('SOURCE_NOT_COLLECTABLE', 409);
        const { rows: [other] } = await client.query(`${LINK_SELECT} WHERE nl.issuer_site=$1
          AND nl.collection_source_type='restaurant_order' AND nl.collection_source->>'attempt'=$2`, [params.site, params.source.attempt]);
        if (other) throw new Error('IDEMPOTENCY_KEY_REUSED');
      }
      const valuation = await valuePointsK({ sourceCurrency: terms.currency, sourceAmountMinor: amountMinor, context: 'payment_link' });
      const slug = crypto.randomBytes(8).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(`payment-link:${slug}`).digest('hex');
      const { rows: [intent] } = await client.query(
        `INSERT INTO konektag.checkout_intents
           (token_hash, amount, quantity_k, currency, service_description, expiration, status, usage_unique,
            source_type, public_id, reference, quote_valuation, collection_route)
         VALUES ($1, $2, $3, $4, $5, $6, 'ISSUED', true, 'payment_link', $7, $8, $9, 'frappe_network') RETURNING id`,
        [tokenHash, amountMinor, valuation.quantityK, terms.currency, params.description, params.expiration,
         slug, invoice.name, JSON.stringify(valuation)]);
      await client.query(
        `INSERT INTO konektag.link_pay_network_links
           (checkout_intent_id, origin_key, issuer_site, beneficiary_site, network_site, invoice, invoice_company,
            beneficiary_name, country, currency, fee_mode, fee_rate_bps, approved_by, approved_at, terms_hash, collection_source_type, collection_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
        [intent.id, params.originKey, params.site, terms.beneficiarySite, terms.networkSite, invoice.name, invoice.company,
         terms.name, terms.country, terms.currency, terms.feeMode, terms.feeRateBps, terms.approvedBy, terms.approvedAt, terms.termsHash,
         params.source ? 'restaurant_order' : 'invoice', params.source ? JSON.stringify(params.source) : null]);
      const { rows: [row] } = await client.query(`${LINK_SELECT} WHERE ci.id = $1`, [intent.id]);
      await client.query('COMMIT');
      return mapNetworkLink(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getBySlug(slug: string, db: Db = pool) {
    const { rows: [row] } = await db.query(`${LINK_SELECT} WHERE ci.public_id = $1 AND ci.source_type = 'payment_link'`, [slug]);
    return row ? { ...mapNetworkLink(row), checkoutIntentId: row.checkout_intent_id as string, valuation: row.quote_valuation,
      source: row.collection_source_type === 'restaurant_order' ? RestaurantSourceSchema.parse(row.collection_source) : null } : null;
  },

  async listForSource(site: string, attempt: string, posProfile: string) {
    const { rows } = await pool.query(
      `${LINK_SELECT.replace('SELECT ci.*, nl.*', `SELECT ci.*, nl.*, t.id AS transaction_id, t.k_operation_id AS operation, t.paid_at,
          t.gross_minor, t.fee_minor, t.net_minor,
          EXISTS (SELECT 1 FROM konektag.k_operations k WHERE k.id=t.k_operation_id AND k.status='completed') AS network_confirmed`)}
       LEFT JOIN konektag.link_pay_network_transactions t ON t.checkout_intent_id=ci.id
       WHERE nl.issuer_site=$1 AND nl.collection_source_type='restaurant_order'
       AND nl.collection_source->>'attempt'=$2 AND nl.collection_source->>'posProfile'=$3`, [site, attempt, posProfile]);
    return rows.map(row => ({ ...mapNetworkLink(row), transactionId: row.transaction_id || null,
      operationId: row.network_confirmed ? row.operation : null,
      paidAt: row.network_confirmed ? row.paid_at : null,
      split: row.transaction_id ? { gross: Number(row.gross_minor), fee: Number(row.fee_minor), net: Number(row.net_minor) } : null }));
  },

  /** Revoke and source release share the same source lock as issuance; never unlock a paid link. */
  async revokeSource(site: string, attempt: string, posProfile: string) {
    const parsed = RestaurantSourceSchema.pick({ attempt: true, posProfile: true }).safeParse({ attempt, posProfile });
    if (!parsed.success) throw new LinkPaySiteError('SOURCE_REFERENCE_INVALID', 400);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`link-pay-source:${site}:${attempt}`]);
      const { rows: [row] } = await client.query(`${LINK_SELECT} WHERE nl.issuer_site=$1
        AND nl.collection_source_type='restaurant_order' AND nl.collection_source->>'attempt'=$2 FOR UPDATE OF ci`, [site, attempt]);
      if (row && row.collection_source?.posProfile !== posProfile) throw new LinkPaySiteError('SOURCE_NOT_FOUND', 404);
      if (row && !['ISSUED', 'EXPIRED'].includes(row.status)) throw new LinkPaySiteError('LINK_NOT_REVOCABLE', 409);
      if (row) await client.query(`UPDATE konektag.checkout_intents SET status='EXPIRED',updated_at=now(),version=version+1 WHERE id=$1`, [row.checkout_intent_id]);
      // No Frappe lock may be held by the caller while it calls this endpoint.
      const released = await releaseRestaurantSource(site, parsed.data, row?.public_id ?? '');
      if (released.state !== 'Cancelled') throw new LinkPaySiteError('SOURCE_NOT_REVOCABLE', 409);
      await client.query('COMMIT');
      return { revoked: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  },

  /**
   * Network confirmation is the completed ledger operation, independent of ERP delivery.
   */
  async listForSiteInvoice(site: string, invoice: string) {
    const { rows } = await pool.query(
      `${LINK_SELECT.replace('SELECT ci.*, nl.*', `SELECT ci.*, nl.*, t.id AS transaction_id, t.k_operation_id AS operation, t.paid_at,
              t.gross_minor, t.fee_minor, t.net_minor,
              EXISTS (SELECT 1 FROM konektag.k_operations k WHERE k.id=t.k_operation_id AND k.status='completed') AS network_confirmed`)}
       LEFT JOIN konektag.link_pay_network_transactions t ON t.checkout_intent_id = ci.id
       WHERE nl.issuer_site = $1 AND nl.invoice = $2 ORDER BY ci.created_at DESC`, [site, invoice]);
    return rows.map(row => ({
      ...mapNetworkLink(row),
      transactionId: row.transaction_id || null,
      operationId: row.network_confirmed ? row.operation : null,
      paidAt: row.network_confirmed ? row.paid_at : null,
      split: row.transaction_id ? { gross: Number(row.gross_minor), fee: Number(row.fee_minor), net: Number(row.net_minor) } : null,
    }));
  },

  /**
   * Caller owns the transaction and has claimed the link. Debits the payer's Points K once, records
   * gross/fee/net with the frozen fee rule and queues the site webhooks, all in that transaction.
   * The reservation key LINK-<slug> makes a replay reuse the same debit.
   */
  async pay(client: PoolClient, input: { slug: string; checkoutIntentId: string; userId: string; amountMinor: number;
    quantityK: number; currency: string }) {
    if (!Number.isSafeInteger(input.quantityK) || input.quantityK <= 0) throw new Error('INVALID_POINTS_QUANTITY');
    const kyc = await checkUserKycVerified(client, input.userId);
    if (!kyc.verified) throw new Error('USER_KYC_REQUIRED');
    const { rows: [link] } = await client.query(
      'SELECT * FROM konektag.link_pay_network_links WHERE checkout_intent_id = $1', [input.checkoutIntentId]);
    if (!link) throw new Error('NETWORK_LINK_NOT_FOUND');
    const { rows: [previous] } = await client.query(
      'SELECT * FROM konektag.link_pay_network_transactions WHERE checkout_intent_id = $1', [input.checkoutIntentId]);
    if (previous) return { kOperationId: previous.k_operation_id as string, transactionId: previous.id as string };
    // Lock current API approval for this transaction; fee amounts remain frozen on the issued link.
    await beneficiaryTerms(link.network_site, link.beneficiary_site, client);
    const partyId = await resolvePointsOwner(client, input.userId);
    await lockPointsOwner(client, partyId);
    const hold = await reservePoints(client, { partyId, operationKey: `LINK-${input.slug}`, quantity: input.quantityK,
      expiresAt: new Date(Date.now() + 30 * 60_000) });
    const kOperationId = await consumeReservedLinkPoints(client, { partyId, reservationId: hold.id,
      operationKey: `points-consumption:${hold.id}`, quantity: input.quantityK });
    const split = splitAmount(input.amountMinor, Number(link.fee_rate_bps));
    const { rows: [transaction] } = await client.query(
      `INSERT INTO konektag.link_pay_network_transactions
         (checkout_intent_id, k_operation_id, payer_user_id, beneficiary_site, network_site, invoice, currency,
          gross_minor, fee_minor, net_minor, quantity_k)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [input.checkoutIntentId, kOperationId, input.userId, link.beneficiary_site, link.network_site, link.invoice,
       input.currency, split.gross, split.fee, split.net, input.quantityK]);
    await enqueueSiteWebhooks(client, { transaction, link, slug: input.slug });
    return { kOperationId, transactionId: transaction.id as string };
  },
};
