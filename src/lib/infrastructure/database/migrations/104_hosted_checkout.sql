-- Hosted Checkout is isolated from the legacy API payment order flow. External
-- provider credentials are kept in a vault; this schema stores references only.
BEGIN;

CREATE TABLE IF NOT EXISTS konektag.provider_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  payment_method VARCHAR(32) NOT NULL CHECK (payment_method IN ('KONEKTAG_WALLET','CARD','MOBILE_MONEY')),
  logo_url TEXT,
  supported_countries JSONB NOT NULL DEFAULT '[]', supported_currencies JSONB NOT NULL DEFAULT '[]',
  connection_modes JSONB NOT NULL DEFAULT '[]', sandbox_supported BOOLEAN NOT NULL DEFAULT true,
  live_supported BOOLEAN NOT NULL DEFAULT true, webhook_supported BOOLEAN NOT NULL DEFAULT true,
  refund_supported BOOLEAN NOT NULL DEFAULT false, partial_refund_supported BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS konektag.merchant_payment_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  provider_definition_id UUID NOT NULL REFERENCES konektag.provider_definitions(id), display_name VARCHAR(160) NOT NULL,
  payment_method VARCHAR(32) NOT NULL CHECK (payment_method IN ('CARD','MOBILE_MONEY')),
  country_code VARCHAR(2), operator_code VARCHAR(64), environment VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox','live')),
  credential_mode VARCHAR(32) NOT NULL CHECK (credential_mode IN ('CONNECTED_ACCOUNT','API_CREDENTIALS')),
  credential_reference TEXT NOT NULL, provider_account_reference TEXT, connection_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_VALIDATION'
    CHECK (connection_status IN ('NOT_CONFIGURED','PENDING_VALIDATION','CONNECTED','INVALID_CREDENTIALS','WEBHOOK_NOT_CONFIGURED','DISABLED','REVOKED','UNAVAILABLE')),
  webhook_status VARCHAR(32) NOT NULL DEFAULT 'NOT_CONFIGURED', enabled BOOLEAN NOT NULL DEFAULT false,
  last_tested_at TIMESTAMPTZ, last_test_result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), version INTEGER NOT NULL DEFAULT 1,
  CHECK (credential_reference LIKE 'vault://%')
);
CREATE INDEX IF NOT EXISTS idx_hosted_provider_account_merchant ON konektag.merchant_payment_provider_accounts(merchant_profile_id, environment);

CREATE TABLE IF NOT EXISTS konektag.hosted_checkout_settings (
  merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id), enabled BOOLEAN NOT NULL DEFAULT false,
  display_name VARCHAR(160), logo_url TEXT, primary_color VARCHAR(16), default_locale VARCHAR(10) NOT NULL DEFAULT 'fr', default_currency VARCHAR(3),
  default_expires_minutes INTEGER NOT NULL DEFAULT 30 CHECK (default_expires_minutes BETWEEN 1 AND 10080), allow_combined_payment BOOLEAN NOT NULL DEFAULT true,
  minimum_amount BIGINT NOT NULL DEFAULT 1, maximum_amount BIGINT, success_url TEXT, cancel_url TEXT,
  checkout_confirmation_url TEXT, payment_confirmation_url TEXT, payment_cancelled_url TEXT, webhook_secret_encrypted BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS konektag.hosted_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id VARCHAR(48) NOT NULL UNIQUE, merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  environment VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox','live')), merchant_reference VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('DRAFT','OPEN','CONFIRMED','PAYMENT_IN_PROGRESS','PARTIALLY_PAID','PAID','CANCELLED','EXPIRED','REFUND_IN_PROGRESS','PARTIALLY_REFUNDED','REFUNDED','RECONCILIATION_REQUIRED')),
  currency VARCHAR(3) NOT NULL, subtotal_amount BIGINT NOT NULL CHECK(subtotal_amount >= 0), tax_amount BIGINT NOT NULL DEFAULT 0 CHECK(tax_amount >= 0), discount_amount BIGINT NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
  shipping_amount BIGINT NOT NULL DEFAULT 0 CHECK(shipping_amount >= 0), total_amount BIGINT NOT NULL CHECK(total_amount >= 0), paid_amount BIGINT NOT NULL DEFAULT 0 CHECK(paid_amount >= 0), remaining_amount BIGINT NOT NULL CHECK(remaining_amount >= 0),
  customer JSONB, success_url TEXT, cancel_url TEXT, checkout_confirmation_url TEXT, payment_confirmation_url TEXT, payment_cancelled_url TEXT,
  expires_at TIMESTAMPTZ NOT NULL, metadata JSONB NOT NULL DEFAULT '{}', cancellation_reason VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), version INTEGER NOT NULL DEFAULT 1,
  CHECK(total_amount = subtotal_amount + tax_amount - discount_amount + shipping_amount),
  CHECK(remaining_amount = total_amount - paid_amount),
  UNIQUE(merchant_profile_id, environment, merchant_reference)
);
CREATE TABLE IF NOT EXISTS konektag.hosted_checkout_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), checkout_id UUID NOT NULL REFERENCES konektag.hosted_checkouts(id) ON DELETE CASCADE,
  merchant_item_reference VARCHAR(255), name VARCHAR(500) NOT NULL, description TEXT, quantity INTEGER NOT NULL CHECK(quantity > 0), unit_amount BIGINT NOT NULL CHECK(unit_amount >= 0),
  subtotal_amount BIGINT NOT NULL CHECK(subtotal_amount >= 0), tax_amount BIGINT NOT NULL DEFAULT 0 CHECK(tax_amount >= 0), discount_amount BIGINT NOT NULL DEFAULT 0 CHECK(discount_amount >= 0), total_amount BIGINT NOT NULL CHECK(total_amount >= 0), image_url TEXT, metadata JSONB NOT NULL DEFAULT '{}',
  CHECK(subtotal_amount = quantity * unit_amount), CHECK(total_amount = subtotal_amount + tax_amount - discount_amount)
);
CREATE TABLE IF NOT EXISTS konektag.hosted_payment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), checkout_id UUID NOT NULL REFERENCES konektag.hosted_checkouts(id), status VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
  CHECK(status IN ('DRAFT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','SUPERSEDED')), total_amount BIGINT NOT NULL CHECK(total_amount >= 0), allocated_amount BIGINT NOT NULL DEFAULT 0 CHECK(allocated_amount >= 0),
  remaining_amount BIGINT NOT NULL CHECK(remaining_amount >= 0), version INTEGER NOT NULL DEFAULT 1, confirmed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(remaining_amount = total_amount - allocated_amount)
);
CREATE TABLE IF NOT EXISTS konektag.hosted_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), payment_plan_id UUID NOT NULL REFERENCES konektag.hosted_payment_plans(id) ON DELETE CASCADE,
  payment_method VARCHAR(32) NOT NULL CHECK(payment_method IN ('KONEKTAG_WALLET','CARD','MOBILE_MONEY')), provider_account_id UUID REFERENCES konektag.merchant_payment_provider_accounts(id),
  amount BIGINT NOT NULL CHECK(amount > 0), country_code VARCHAR(2), operator_code VARCHAR(64), execution_order INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','CANCELLED','REPLACED')),
  CHECK ((payment_method = 'KONEKTAG_WALLET' AND provider_account_id IS NULL) OR (payment_method <> 'KONEKTAG_WALLET' AND provider_account_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS konektag.hosted_payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), checkout_id UUID NOT NULL REFERENCES konektag.hosted_checkouts(id), payment_plan_id UUID NOT NULL REFERENCES konektag.hosted_payment_plans(id),
  payment_allocation_id UUID NOT NULL REFERENCES konektag.hosted_payment_allocations(id), provider_account_id UUID REFERENCES konektag.merchant_payment_provider_accounts(id),
  provider_payment_id VARCHAR(255), payment_method VARCHAR(32) NOT NULL CHECK(payment_method IN ('KONEKTAG_WALLET','CARD','MOBILE_MONEY')), amount BIGINT NOT NULL CHECK(amount > 0), currency VARCHAR(3) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'CREATED'
    CHECK(status IN ('CREATED','PENDING','ACTION_REQUIRED','PROCESSING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','REFUNDED')),
  failure_code VARCHAR(80), failure_message VARCHAR(500), idempotency_key VARCHAR(255) NOT NULL UNIQUE, initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(), confirmed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hosted_provider_payment ON konektag.hosted_payment_attempts(provider_account_id, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hosted_items_checkout ON konektag.hosted_checkout_items(checkout_id);
CREATE INDEX IF NOT EXISTS idx_hosted_plans_checkout ON konektag.hosted_payment_plans(checkout_id);
CREATE INDEX IF NOT EXISTS idx_hosted_attempts_checkout ON konektag.hosted_payment_attempts(checkout_id);
CREATE INDEX IF NOT EXISTS idx_hosted_attempts_allocation ON konektag.hosted_payment_attempts(payment_allocation_id);
CREATE TABLE IF NOT EXISTS konektag.provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider_definition_id UUID NOT NULL REFERENCES konektag.provider_definitions(id), provider_account_id UUID NOT NULL REFERENCES konektag.merchant_payment_provider_accounts(id),
  provider_event_id VARCHAR(255) NOT NULL, provider_payment_id VARCHAR(255), event_type VARCHAR(120) NOT NULL, payload_hash VARCHAR(64) NOT NULL, raw_payload_reference TEXT,
  signature_valid BOOLEAN NOT NULL, processing_status VARCHAR(24) NOT NULL DEFAULT 'RECEIVED' CHECK(processing_status IN ('RECEIVED','VALIDATED','PROCESSED','IGNORED','FAILED','DEAD_LETTERED')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, UNIQUE(provider_account_id, provider_event_id)
);
CREATE TABLE IF NOT EXISTS konektag.hosted_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id), checkout_id UUID NOT NULL REFERENCES konektag.hosted_checkouts(id),
  event_id UUID NOT NULL, event_type VARCHAR(64) NOT NULL, target_url_type VARCHAR(32) NOT NULL, target_url TEXT NOT NULL, payload JSONB NOT NULL, payload_hash VARCHAR(64) NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0, status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DELIVERED','FAILED','DEAD_LETTERED')),
  last_http_status INTEGER, last_error VARCHAR(500), next_retry_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(checkout_id,event_type)
);

INSERT INTO konektag.provider_definitions(code,name,payment_method,connection_modes)
VALUES ('STRIPE','Stripe','CARD','["CONNECTED_ACCOUNT","API_CREDENTIALS"]'), ('KONEKTAG_WALLET','Konektag Wallet','KONEKTAG_WALLET','[]'), ('MTN_MOMO','MTN Mobile Money','MOBILE_MONEY','["API_CREDENTIALS"]')
ON CONFLICT(code) DO NOTHING;
COMMIT;
