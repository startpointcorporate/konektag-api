BEGIN;

-- Runtime projection of Frappe-managed merchant product prices.
CREATE TABLE IF NOT EXISTS konektag.product_pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  product_code VARCHAR(100) NOT NULL,
  market_country VARCHAR(5) NOT NULL,
  seller_legal_entity_code VARCHAR(20) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  min_quantity INTEGER CHECK (min_quantity IS NULL OR min_quantity > 0),
  max_quantity INTEGER CHECK (max_quantity IS NULL OR max_quantity > 0),
  offer_code VARCHAR(100) NOT NULL DEFAULT '',
  pricing_version INTEGER NOT NULL DEFAULT 1 CHECK (pricing_version > 0),
  priority INTEGER NOT NULL DEFAULT 0,
  valid_from DATE NOT NULL,
  valid_until DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'APPROVED'
    CHECK (status IN ('DRAFT', 'APPROVED', 'SUSPENDED', 'ARCHIVED')),
  source_doctype VARCHAR(80) NOT NULL DEFAULT 'KTG Merchant Product Price',
  source_name VARCHAR(140),
  payload_hash VARCHAR(64),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT ck_product_pricing_quantity_range
    CHECK (max_quantity IS NULL OR min_quantity IS NULL OR max_quantity >= min_quantity)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_pricing_rule_identity
  ON konektag.product_pricing_rules(
    merchant_profile_id,
    product_code,
    market_country,
    seller_legal_entity_code,
    pricing_version,
    offer_code
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_pricing_rule_lookup
  ON konektag.product_pricing_rules(
    merchant_profile_id,
    product_code,
    market_country,
    status,
    valid_from,
    valid_until,
    priority DESC,
    pricing_version DESC
  )
  WHERE deleted_at IS NULL;

-- Immutable pricing snapshot stored on API checkout orders.
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS product_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS market_country VARCHAR(5),
  ADD COLUMN IF NOT EXISTS seller_legal_entity_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pricing_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS unit_price INTEGER,
  ADD COLUMN IF NOT EXISTS pricing_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS sale_price INTEGER,
  ADD COLUMN IF NOT EXISTS pricing_version INTEGER,
  ADD COLUMN IF NOT EXISTS pricing_source VARCHAR(40),
  ADD COLUMN IF NOT EXISTS pricing_rule_code VARCHAR(140),
  ADD COLUMN IF NOT EXISTS pricing_valid_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_product_code
  ON konektag.api_payment_orders(product_code, created_at DESC)
  WHERE product_code IS NOT NULL;

COMMIT;