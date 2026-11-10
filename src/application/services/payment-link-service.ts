import crypto from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import { currencyForMerchantCountry } from './country-currency-service.ts';
import { valuePointsK } from './points-k-valuation-service.ts';
import { PointsKValuationSchema } from '../../domain/points-k-valuation.ts';
import { majorToMinor } from './pay/money-unit.ts';

/** Links issued before server valuation carry no provable quantity and cannot be paid. */
function linkValuation(row: any) {
  const parsed = PointsKValuationSchema.safeParse(row.quote_valuation);
  if (!parsed.success || parsed.data.quantityK !== Number(row.quantity_k)
    || parsed.data.sourceAmountMinor !== Number(row.amount) || parsed.data.sourceCurrency !== row.currency) return null;
  return parsed.data;
}

/** Settlement facts are only for the merchant's own owner/manager listing (ERP reconciliation). */
function settlement(row: any) {
  return row.status === 'CONSUMED' ? {
    operationId: row.k_operation_id || row.operation_id || null,
    paidAt: row.consumed_at || null,
  } : { operationId: null, paidAt: null };
}

function mapLink(row: any) {
  const expired = !row.expiration || !Number.isFinite(new Date(row.expiration).getTime())
    || new Date(row.expiration).getTime() <= Date.now();
  const status = row.status === 'CONSUMED' ? 'Used' : row.status === 'EXPIRED' || expired ? 'Expired'
    : row.status === 'ISSUED' ? 'Active' : 'Inactive';
  return {
    name: row.public_id, url_slug: row.public_id, etablissement: row.business_name,
    merchant: row.merchant_profile_id, amount: Number(row.amount), quantityK: Number(row.quantity_k), valuation: linkValuation(row), description: row.service_description || '',
    reference: row.reference || '', expires_at: row.expiration, status, creation: row.created_at,
    currency: row.currency,
  };
}

export const paymentLinkService = {
  /** The link freezes the official Points K valuation of its commercial amount at issuance. */
  async create(params: { merchantProfileId: string; currency?: string; description?: string; reference?: string; expiration: Date; catalog?: {transactionId:string} }
    & ({ amountMinor: number; amountMajor?: never } | { amountMajor: string; amountMinor?: never })
    & { clientValuation?: { amountMinor: unknown; currency: unknown; quantityK: unknown; reference: unknown }; idempotencyKey?: string }) {
    const { rows: [merchant] } = await pool.query(
      `SELECT country FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [params.merchantProfileId],
    );
    if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
    const currency = currencyForMerchantCountry(merchant.country);
    if (params.currency && String(params.currency).trim().toUpperCase() !== currency) {
      throw new Error('MERCHANT_CURRENCY_MISMATCH');
    }
    // A merchant enters the amount in major units; minor units depend on the merchant country currency.
    const amountMinor = params.amountMajor !== undefined ? majorToMinor(params.amountMajor, currency) : params.amountMinor;
    // Link Pay is an online service: the authoritative Points K valuation is produced server-side.
    const valuation = await valuePointsK({
      sourceCurrency: currency,
      sourceAmountMinor: amountMinor,
      context: params.catalog ? 'catalog_checkout' : 'payment_link',
    });
    const slug = crypto.randomBytes(8).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(`payment-link:${slug}`).digest('hex');
    // The catalogue's transaction id is a UUID reference (core_transaction_id); text replay keys
    // (erp-link:…, BOOST-LINK-…) have their own column, unique per merchant (migration 230).
    const coreTransactionId = params.catalog?.transactionId || null;
    const replayKey = params.catalog ? null : params.idempotencyKey || null;
    let { rows: [row] } = await pool.query(
      `INSERT INTO konektag.checkout_intents
       (token_hash, merchant_profile_id, amount, quantity_k, currency, service_description, expiration,
        status, usage_unique, source_type, public_id, reference, core_transaction_id, quote_valuation, replay_key)
        VALUES ($1, $2, $9, $3, $4, $5, $6, 'ISSUED', true, 'payment_link', $7, $8, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [tokenHash, params.merchantProfileId, valuation.quantityK, currency, params.description || null,
       params.expiration, slug, params.reference || null, amountMinor, coreTransactionId, JSON.stringify(valuation), replayKey],
    );
    if (!row && (coreTransactionId || replayKey)) {
      const existing = await pool.query(
        `SELECT * FROM konektag.checkout_intents WHERE merchant_profile_id = $2 AND source_type = 'payment_link'
           AND ${coreTransactionId ? 'core_transaction_id = $1::uuid' : 'replay_key = $1'}`,
        [coreTransactionId || replayKey, params.merchantProfileId]);
      row = existing.rows[0];
    }
    if(!row)throw new Error('CHECKOUT_CREATION_FAILED');
    if(params.idempotencyKey && !params.catalog && (Number(row.amount)!==amountMinor || row.currency!==currency
      || (row.reference||null)!==(params.reference||null)))throw new Error('IDEMPOTENCY_KEY_REUSED');
    const { rows: [profile] } = await pool.query(
      `SELECT business_name FROM konektag.merchant_profiles WHERE id = $1`, [params.merchantProfileId]);
    return mapLink({ ...row, business_name: profile?.business_name });
  },

  async get(slug: string) {
    const { rows: [row] } = await pool.query(
      `SELECT ci.*, COALESCE(mp.business_name, nl.beneficiary_name) AS business_name FROM konektag.checkout_intents ci
       LEFT JOIN konektag.merchant_profiles mp ON mp.id = ci.merchant_profile_id
       LEFT JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
       WHERE ci.public_id = $1 AND ci.source_type = 'payment_link'
         AND (mp.id IS NOT NULL OR nl.checkout_intent_id IS NOT NULL)`, [slug]);
    return row ? mapLink(row) : null;
  },

  async claim(slug: string, client: Pick<PoolClient, 'query'> = pool) {
    const { rows: [row] } = await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'PROCESSING', updated_at = now(), version = version + 1
       WHERE public_id = $1 AND source_type = 'payment_link' AND status = 'ISSUED'
         AND expiration > now()
       RETURNING id`, [slug]);
    return Boolean(row);
  },

  async release(slug: string, client: Pick<PoolClient, 'query'> = pool) {
    await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'ISSUED', updated_at = now(), version = version + 1
       WHERE public_id = $1 AND source_type = 'payment_link' AND status = 'PROCESSING'`, [slug]);
  },

  async complete(slug: string, params: {
    payerUserId: string;
    payerIdentity?: string | null;
    externalTransactionId?: string | null;
    financialTransactionId?: string;
    kOperationId?: string;
  }, client: Pick<PoolClient, 'query'> = pool) {
    const { rowCount } = await client.query(
      `UPDATE konektag.checkout_intents
       SET status = 'CONSUMED', payer_user_id = $1, payer_identity = $2,
           external_transaction_id = $3, financial_transaction_id = $4, k_operation_id = $6,
           operation_id = COALESCE($6::uuid, $4::uuid), consumed_at = now(), updated_at = now(), version = version + 1
       WHERE public_id = $5 AND source_type = 'payment_link' AND status = 'PROCESSING'
       RETURNING id`,
      [params.payerUserId, params.payerIdentity || null, params.externalTransactionId || null,
       params.financialTransactionId || null, slug, params.kOperationId || null]);
    return Boolean(rowCount);
  },

  async listForUser(userId: string) {
    const { rows } = await pool.query(
      `SELECT ci.*, mp.business_name FROM konektag.checkout_intents ci
       JOIN konektag.merchant_profiles mp ON mp.id = ci.merchant_profile_id
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
       WHERE mm.user_id = $1 AND mm.status = 'active' AND mm.role IN ('owner', 'manager')
         AND ci.source_type = 'payment_link'
       ORDER BY ci.created_at DESC`, [userId]);
    return rows.map(row => ({ ...mapLink(row), ...settlement(row) }));
  },
};

