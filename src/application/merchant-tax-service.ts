import pool from '../infrastructure/database/pool.ts';
import { requireCoreMerchantActor } from './core-transaction-service.ts';

export interface MerchantTaxInput {
  merchantProfileId: string; productId: string; pricingRuleId?: string;
  countryCode: string; taxCode: string; taxName: string;
  rateBasisPoints: number; enabled: boolean; expectedVersion?: number;
}

export async function listMerchantTaxes(actorUserId: string, merchantProfileId: string, productId?: string) {
  const client = await pool.connect();
  try {
    await requireCoreMerchantActor(client, merchantProfileId, actorUserId);
    const { rows } = await client.query(`SELECT id, merchant_product_id AS "productId", pricing_rule_id AS "pricingRuleId",
      country_code AS "countryCode", tax_code AS "taxCode", tax_name AS "taxName", rate_basis_points AS "rateBasisPoints",
      enabled, version FROM konektag.merchant_product_tax_rules
      WHERE merchant_profile_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR merchant_product_id=$2)
      ORDER BY merchant_product_id,country_code,tax_code,version DESC`, [merchantProfileId, productId ?? null]);
    return rows;
  } finally { client.release(); }
}

export async function upsertMerchantTax(actorUserId: string, input: MerchantTaxInput) {
  if (!/^[A-Z]{2,5}$/.test(input.countryCode) || !/^[A-Za-z0-9_.-]{1,80}$/.test(input.taxCode) ||
      !input.taxName.trim() || !Number.isInteger(input.rateBasisPoints) || input.rateBasisPoints < 0 || input.rateBasisPoints > 10000) {
    throw new Error('INVALID_TAX_CONFIGURATION');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireCoreMerchantActor(client, input.merchantProfileId, actorUserId);
    const { rows: [product] } = await client.query(`SELECT id FROM konektag.merchant_products
      WHERE id=$1 AND merchant_profile_id=$2 AND deleted_at IS NULL FOR UPDATE`, [input.productId, input.merchantProfileId]);
    if (!product) throw new Error('PRODUCT_NOT_OWNED');
    if (input.pricingRuleId) {
      const { rowCount } = await client.query(`SELECT 1 FROM konektag.product_pricing_rules
        WHERE id=$1 AND merchant_profile_id=$2 AND merchant_product_id=$3 AND deleted_at IS NULL`,
        [input.pricingRuleId, input.merchantProfileId, input.productId]);
      if (!rowCount) throw new Error('INVALID_PRICING_RULE');
    }
    const { rows: [current] } = await client.query<{ version: number }>(`SELECT version FROM konektag.merchant_product_tax_rules
      WHERE merchant_profile_id=$1 AND merchant_product_id=$2 AND pricing_rule_id IS NOT DISTINCT FROM $3
        AND country_code=$4 AND tax_code=$5 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [input.merchantProfileId,input.productId,input.pricingRuleId ?? null,input.countryCode,input.taxCode]);
    if (input.expectedVersion !== undefined && (!current || Number(current.version) !== input.expectedVersion)) throw new Error('VERSION_CONFLICT');
    const nextVersion = Number(current?.version ?? 0) + 1;
    await client.query(`INSERT INTO konektag.merchant_product_tax_rules
      (merchant_profile_id,merchant_product_id,pricing_rule_id,country_code,tax_code,tax_name,rate_basis_points,enabled,version,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [input.merchantProfileId,input.productId,input.pricingRuleId ?? null,input.countryCode,input.taxCode,input.taxName.trim(),input.rateBasisPoints,input.enabled,nextVersion,actorUserId]);
    await client.query(`INSERT INTO konektag.audit_logs (user_id,correlation_id,event_type,payload)
      VALUES ($1,gen_random_uuid(),'MerchantTaxRuleUpdated',$2)`, [actorUserId, JSON.stringify({ ...input, version: nextVersion })]);
    await client.query('COMMIT');
    return { ...input, version: nextVersion };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
