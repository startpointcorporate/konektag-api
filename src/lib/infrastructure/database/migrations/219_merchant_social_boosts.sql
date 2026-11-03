BEGIN;

CREATE TABLE IF NOT EXISTS konektag.merchant_social_boosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES konektag.merchant_social_campaigns(id) ON DELETE CASCADE,
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','QUOTED','PAYMENT_PENDING','PAID','BOOSTED','COMPLETED','CANCELLED')),
  channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_minor BIGINT NOT NULL CHECK (budget_minor > 0),
  currency VARCHAR(3) NOT NULL,
  service_price_minor BIGINT CHECK (service_price_minor IS NULL OR service_price_minor >= 0),
  theoretical_impressions BIGINT CHECK (theoretical_impressions IS NULL OR theoretical_impressions >= 0),
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  tracking_url TEXT,
  visits BIGINT NOT NULL DEFAULT 0 CHECK (visits >= 0),
  payment_link TEXT,
  payment_reference TEXT,
  paid_at TIMESTAMPTZ,
  boosted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  admin_note TEXT,
  erp_invoice VARCHAR(140),
  erp_error TEXT,
  erp_synced_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_boost_campaign_unique ON konektag.merchant_social_boosts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_social_boost_merchant_created
  ON konektag.merchant_social_boosts(merchant_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_boost_admin_queue
  ON konektag.merchant_social_boosts(status, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_boost_payment_reference
  ON konektag.merchant_social_boosts(payment_reference)
  WHERE payment_reference IS NOT NULL;

COMMIT;
