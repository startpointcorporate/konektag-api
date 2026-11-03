BEGIN;
-- Correct the authority described by migration 128 without rewriting historical provenance.
ALTER TABLE konektag.product_pricing_rules
 ADD COLUMN IF NOT EXISTS price_authority TEXT NOT NULL DEFAULT 'LEGACY_UNSPECIFIED',
 ADD COLUMN IF NOT EXISTS is_catalog_base BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE konektag.product_pricing_rules ALTER COLUMN price_authority SET DEFAULT 'KONEKTAG_MERCHANT';
ALTER TABLE konektag.product_pricing_rules ALTER COLUMN source_doctype SET DEFAULT 'Konektag Merchant Catalog';
ALTER TABLE konektag.product_pricing_rules ALTER COLUMN seller_legal_entity_code DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pro06_catalog_base_price
 ON konektag.product_pricing_rules(merchant_profile_id,merchant_product_id)
 WHERE is_catalog_base AND deleted_at IS NULL;
COMMENT ON TABLE konektag.product_pricing_rules IS 'Merchant-owned Konektag catalog prices. No Frappe approval. Historical projection metadata is retained as evidence.';
COMMENT ON COLUMN konektag.product_pricing_rules.seller_legal_entity_code IS 'Legacy pricing context; not an authority or prerequisite for merchant catalog prices. Payment legal entities are resolved separately.';
COMMENT ON COLUMN konektag.product_pricing_rules.status IS 'Local price availability; APPROVED means usable in Konektag, not approved by Frappe.';
COMMENT ON COLUMN konektag.product_pricing_rules.price_authority IS 'Authority of the last price write. Legacy provenance is not retrospectively rewritten.';
COMMIT;
