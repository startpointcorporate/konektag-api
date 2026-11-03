import pool from '../infrastructure/database/pool.ts';
import { requireCoreMerchantActor } from './core-transaction-service.ts';
import { allowedTransactionCommands } from '../domain/core-business.ts';
import { listActivePromotions } from './promotion-service.ts';

export async function operationEstablishments(actorUserId: string) {
  const { rows } = await pool.query(`SELECT mp.id, mp.business_name AS name
    FROM konektag.merchant_profiles mp WHERE mp.deleted_at IS NULL AND
    (mp.user_id=$1 OR EXISTS (SELECT 1 FROM konektag.merchant_memberships mm
      WHERE mm.merchant_profile_id=mp.id AND mm.user_id=$1 AND mm.status='active' AND mm.role IN ('owner','manager')))
    ORDER BY mp.business_name, mp.id`, [actorUserId]);
  return rows;
}

export async function merchantOperations(actorUserId: string, merchantProfileId: string, search = '', page = 1) {
  const client = await pool.connect();
  try {
    await requireCoreMerchantActor(client, merchantProfileId, actorUserId);
    const { rows: offers } = await client.query(`SELECT p.id AS "offerId", r.id AS "pricingRuleId", p.name, oc.code AS category,
      r.unit_price AS "amountMinor", r.currency, r.market_country AS "marketCountry",
      r.seller_legal_entity_code AS "legalEntity", r.min_quantity AS "minQuantity", r.max_quantity AS "maxQuantity",
      r.pricing_version AS "pricingVersion"
      FROM konektag.merchant_products p JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id
      JOIN konektag.product_pricing_rules r
        ON r.merchant_product_id=p.id AND r.merchant_profile_id=p.merchant_profile_id
      WHERE p.merchant_profile_id=$1 AND p.deleted_at IS NULL AND r.deleted_at IS NULL
        AND r.status='APPROVED' AND r.valid_from<=CURRENT_DATE AND (r.valid_until IS NULL OR r.valid_until>=CURRENT_DATE)
        AND (strpos(lower(p.name), lower($2))>0 OR strpos(lower(COALESCE(p.description,'')),lower($2))>0)
      ORDER BY p.name,r.id LIMIT 100`, [merchantProfileId, search]);
    const { rows: transactions } = await client.query(`SELECT t.id, t.kind, t.state, t.state_version AS version,
      t.total_minor AS "amountMinor", t.subtotal_minor AS "subtotalMinor", t.discount_minor AS "discountMinor",
      t.tax_minor AS "taxMinor", t.pricing_country AS "pricingCountry", t.fiscal_snapshot_version AS "fiscalSnapshotVersion",
      t.promotion_id AS "promotionId", t.promotion_fingerprint AS "promotionFingerprint", t.promotion_snapshot AS "promotionSnapshot",
      t.currency, t.created_at AS "createdAt", t.note,
      t.created_by_user_id AS "createdByUserId", t.customer_user_id AS "customerUserId",
      COALESCE((SELECT json_agg(json_build_object('id',l.id,'label',l.label,'quantity',l.quantity,
        'amountMinor',l.unit_amount_minor,'unitPriceMinor',l.unit_price_minor,'currency',l.currency,
        'pricingCountry',l.pricing_country,'subtotalMinor',l.subtotal_minor,'discountMinor',l.discount_minor,
        'taxRateBasisPoints',l.tax_rate_basis_points,'taxMinor',l.tax_minor,'totalMinor',l.total_minor,
        'allocatedUnits',
        (SELECT COALESCE(sum(a.units),0) FROM konektag.core_allocations a WHERE a.transaction_line_id=l.id AND a.state='ACTIVE')) ORDER BY l.id)
        FROM konektag.core_transaction_lines l WHERE l.transaction_id=t.id AND l.merchant_profile_id=t.merchant_profile_id),'[]') AS lines,
      COALESCE((SELECT json_agg(json_build_object('command',j.command,'actorUserId',j.actor_user_id,
        'fromState',j.from_state,'toState',j.to_state,'version',j.to_version,'occurredAt',j.occurred_at) ORDER BY j.to_version)
        FROM konektag.core_transition_journal j WHERE j.transaction_id=t.id AND j.merchant_profile_id=t.merchant_profile_id),'[]') AS history
      FROM konektag.core_transactions t WHERE t.merchant_profile_id=$1
      ORDER BY t.created_at DESC,t.id DESC LIMIT 51 OFFSET $2`, [merchantProfileId,(page-1)*50]);
    const { rows: availabilities } = await client.query(`SELECT a.id, r.label, a.starts_at AS "startsAt", a.ends_at AS "endsAt",
      a.available_units - COALESCE((SELECT sum(x.units) FROM konektag.core_allocations x WHERE x.availability_id=a.id AND x.state='ACTIVE'),0) AS remaining
      FROM konektag.core_availabilities a JOIN konektag.core_capacities c ON c.id=a.capacity_id AND c.merchant_profile_id=a.merchant_profile_id
      JOIN konektag.core_resources r ON r.id=c.resource_id AND r.merchant_profile_id=a.merchant_profile_id
      WHERE a.merchant_profile_id=$1 AND r.active ORDER BY a.starts_at,a.id`, [merchantProfileId]);
    const promotions = await listActivePromotions(client, merchantProfileId);
    return { offers: offers.map(row => ({ ...row, amountMinor: Number(row.amountMinor) })), promotions,
      transactions: transactions.slice(0,50).map(row => ({ ...row, amountMinor: Number(row.amountMinor),
        allowedCommands: allowedTransactionCommands(row.kind,row.state) })),
      availabilities, page, hasMore: transactions.length>50 };
  } finally { client.release(); }
}
