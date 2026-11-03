import pool from '../infrastructure/database/pool.ts';
import { requireCoreMerchantActor } from './core-transaction-service.ts';
import { merchantOperations } from './merchant-operations-service.ts';
import { valuePointsK } from './services/points-k-valuation-service.ts';
import { listActivePromotions } from './promotion-service.ts';

/** Server-authoritative, read-only payload used by the merchant offline projection. */
export async function merchantOfflineSnapshot(actorUserId: string, merchantProfileId: string) {
  const client = await pool.connect();
  try {
    await requireCoreMerchantActor(client, merchantProfileId, actorUserId);
    const { rows: [account] } = await client.query(
      `SELECT u.id AS "userId", u.username, u.locale, u.display_name AS "displayName", u.version,
              mm.role, mm.merchant_profile_id AS "merchantProfileId"
       FROM konektag.users u
       JOIN konektag.merchant_memberships mm ON mm.user_id=u.id
       WHERE u.id=$1 AND mm.merchant_profile_id=$2 AND mm.status='active'
       LIMIT 1`, [actorUserId, merchantProfileId]);
    const { rows: [establishment] } = await client.query(
      `SELECT id, business_name AS "businessName", slug,
              short_description AS "shortDescription", address, city, country, phone,
              email, website_url AS "websiteUrl", status, version, updated_at AS "updatedAt"
       FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL`, [merchantProfileId]);
    if (!account || !establishment) throw new Error('MERCHANT_ACCESS_DENIED');
    const { rows: products } = await client.query(
      `SELECT p.id, p.name, p.description, oc.code AS category, p.offer_category_id AS "offerCategoryId",
              p.offer_subcategory_id AS "offerSubcategoryId", p.price, p.currency, p.version, p.updated_at AS "updatedAt"
       FROM konektag.merchant_products p
       JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.deleted_at IS NULL
       WHERE p.merchant_profile_id=$1 AND p.deleted_at IS NULL ORDER BY p.display_order, p.id`, [merchantProfileId]);
    const operations = await merchantOperations(actorUserId, merchantProfileId, '', 1);
    const promotions = await listActivePromotions(client, merchantProfileId);
    const offers = [] as any[];
    for (const offer of operations.offers) {
      const min = Number(offer.minQuantity ?? 1), max = offer.maxQuantity === null ? null : Number(offer.maxQuantity);
      const offlineValuations: any[] = [];
      if (max !== null && Number.isSafeInteger(min) && Number.isSafeInteger(max) && max >= min) {
        for (let quantity = min; quantity <= max; quantity++) {
          try {
            offlineValuations.push({ quantity, unitPriceMinor: Number(offer.amountMinor),
              ...(await valuePointsK({ sourceCurrency: offer.currency, sourceAmountMinor: Number(offer.amountMinor) * quantity }, client)) });
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('POINTS_K_')) throw error;
          }
        }
      }
      offers.push({ ...offer, amountMinor: Number(offer.amountMinor), pricingVersion: Number(offer.pricingVersion ?? 1),
        offlinePaymentEligible: offlineValuations.length > 0, offlineValuations });
    }
    return {
      account,
      establishment,
      catalogue: { products, offers, promotions },
      transactions: operations.transactions,
      availabilities: operations.availabilities,
      serverVersion: Number(establishment.version ?? 0),
      syncedAt: new Date().toISOString(),
    };
  } finally { client.release(); }
}
