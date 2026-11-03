BEGIN;

-- Merchant-owned tax rules. No default rate is created: an absent or disabled
-- rule produces zero tax, while an enabled rule is explicitly configured.
CREATE TABLE IF NOT EXISTS konektag.merchant_product_tax_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  merchant_product_id UUID NOT NULL,
  pricing_rule_id UUID,
  country_code VARCHAR(5) NOT NULL,
  tax_code VARCHAR(80) NOT NULL,
  tax_name VARCHAR(160) NOT NULL,
  rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0 AND rate_basis_points <= 10000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  created_by UUID REFERENCES konektag.users(id),
  updated_by UUID REFERENCES konektag.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (merchant_product_id, merchant_profile_id)
    REFERENCES konektag.merchant_products(id, merchant_profile_id),
  FOREIGN KEY (pricing_rule_id, merchant_profile_id)
    REFERENCES konektag.product_pricing_rules(id, merchant_profile_id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_product_tax_rule_identity
  ON konektag.merchant_product_tax_rules(merchant_profile_id, merchant_product_id,
    pricing_rule_id, country_code, tax_code, version)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS merchant_product_tax_rule_lookup
  ON konektag.merchant_product_tax_rules(merchant_profile_id, merchant_product_id,
    pricing_rule_id, country_code, enabled, valid_from, valid_until, version DESC)
  WHERE deleted_at IS NULL;

-- Immutable fiscal snapshot on the canonical transaction and each line.
ALTER TABLE konektag.core_transactions
  ADD COLUMN IF NOT EXISTS pricing_country VARCHAR(5),
  ADD COLUMN IF NOT EXISTS subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  ADD COLUMN IF NOT EXISTS discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  ADD COLUMN IF NOT EXISTS fiscal_snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_snapshot_version > 0);
ALTER TABLE konektag.core_transaction_lines
  ADD COLUMN IF NOT EXISTS pricing_country VARCHAR(5),
  ADD COLUMN IF NOT EXISTS unit_price_minor BIGINT,
  ADD COLUMN IF NOT EXISTS subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  ADD COLUMN IF NOT EXISTS discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  ADD COLUMN IF NOT EXISTS tax_rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_basis_points >= 0 AND tax_rate_basis_points <= 10000),
  ADD COLUMN IF NOT EXISTS tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  ADD COLUMN IF NOT EXISTS total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  ADD COLUMN IF NOT EXISTS fiscal_snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_snapshot_version > 0);

COMMIT;
