BEGIN;

-- Provider insights are historic observations, not ERPNext selling prices.
-- Never overwrite Item Price or configured Konektag market ownership.
CREATE TABLE IF NOT EXISTS konektag.social_cpm_daily_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_day DATE NOT NULL,
  billing_company TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook','instagram','tiktok')),
  target_country CHAR(2) NOT NULL CHECK (target_country ~ '^[A-Z]{2}$'),
  ad_account_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('meta_ads_insights','tiktok_ads_reporting')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  spend_major NUMERIC(24,6) NOT NULL CHECK (spend_major >= 0),
  impressions BIGINT NOT NULL CHECK (impressions > 0),
  cpm_major NUMERIC(24,6) GENERATED ALWAYS AS
    (ROUND((spend_major * 1000 / impressions),6)) STORED,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_cpm_daily_observation_unique
    UNIQUE (observation_day,billing_company,platform,target_country,ad_account_ref,source)
);
CREATE INDEX IF NOT EXISTS social_cpm_observation_market_idx
  ON konektag.social_cpm_daily_observations
  (billing_company,target_country,platform,observation_day DESC);

-- No provider credentials, ad account IDs or user identifiers are written to
-- this migration. Accounts are keyed by opaque references supplied at runtime.
COMMIT;
