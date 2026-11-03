-- Settlement destination is a merchant-wide configuration, independent from
-- customer payment methods and reusable by every payment channel.
BEGIN;

ALTER TABLE konektag.merchant_payment_provider_accounts
  DROP CONSTRAINT IF EXISTS merchant_payment_provider_accounts_payment_method_check;
ALTER TABLE konektag.merchant_payment_provider_accounts
  ADD CONSTRAINT merchant_payment_provider_accounts_payment_method_check
  CHECK (payment_method IN ('CARD', 'MOBILE_MONEY'));

CREATE TABLE IF NOT EXISTS konektag.merchant_settlement_configurations (
  merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  provider_account_id UUID NOT NULL REFERENCES konektag.merchant_payment_provider_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_merchant_settlement_configuration_account ON konektag.merchant_settlement_configurations(provider_account_id);
COMMIT;
