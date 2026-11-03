BEGIN;

-- Preserve historical mappings as unscoped. Never guess their billing company.
ALTER TABLE konektag.merchant_social_boost_pricing
  ADD COLUMN IF NOT EXISTS billing_company TEXT;
ALTER TABLE konektag.merchant_social_boost_pricing
  DROP CONSTRAINT IF EXISTS merchant_social_boost_pricing_channel_country_unique;
CREATE UNIQUE INDEX IF NOT EXISTS merchant_social_boost_pricing_company_unique
  ON konektag.merchant_social_boost_pricing(channel,target_country,billing_company);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_social_boost_pricing_legacy_unique
  ON konektag.merchant_social_boost_pricing(channel,target_country) WHERE billing_company IS NULL;
ALTER TABLE konektag.merchant_social_boost_pricing
  ADD CONSTRAINT merchant_social_boost_pricing_billing_company_check
  CHECK (billing_company IS NULL OR length(trim(billing_company)) BETWEEN 1 AND 140);

COMMIT;
