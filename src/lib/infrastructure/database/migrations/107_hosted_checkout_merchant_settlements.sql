-- Hosted Checkout settles merchant proceeds through the merchant's PSP/bank,
-- never through a Konektag merchant wallet.
BEGIN;

ALTER TABLE konektag.hosted_checkout_settings
  ADD COLUMN IF NOT EXISTS enable_konektag_wallet BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS enable_stripe BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_mobile_money BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS konektag.hosted_merchant_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  checkout_id UUID NOT NULL REFERENCES konektag.hosted_checkouts(id),
  payment_allocation_id UUID NOT NULL REFERENCES konektag.hosted_payment_allocations(id),
  settlement_provider_account_id UUID NOT NULL REFERENCES konektag.merchant_payment_provider_accounts(id),
  gross_amount BIGINT NOT NULL CHECK (gross_amount > 0),
  fees_amount BIGINT NOT NULL DEFAULT 0 CHECK (fees_amount >= 0),
  net_amount BIGINT NOT NULL CHECK (net_amount >= 0),
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'CONFIRMED', 'FAILED', 'RECONCILIATION_REQUIRED')),
  provider_reference VARCHAR(255),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (net_amount = gross_amount - fees_amount),
  UNIQUE (payment_allocation_id)
);
CREATE INDEX IF NOT EXISTS idx_hosted_merchant_settlements_merchant ON konektag.hosted_merchant_settlements(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_hosted_merchant_settlements_provider ON konektag.hosted_merchant_settlements(settlement_provider_account_id, status);

INSERT INTO konektag.provider_definitions(code, name, payment_method, connection_modes)
VALUES
  ('AIRTEL_MONEY', 'Airtel Money', 'MOBILE_MONEY', '["API_CREDENTIALS"]'),
  ('ORANGE_MONEY', 'Orange Money', 'MOBILE_MONEY', '["API_CREDENTIALS"]'),
  ('BANK_PSP', 'Bank or PSP', 'CARD', '["API_CREDENTIALS"]')
ON CONFLICT (code) DO NOTHING;
COMMIT;
