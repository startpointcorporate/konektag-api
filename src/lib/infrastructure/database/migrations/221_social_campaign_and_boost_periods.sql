BEGIN;

ALTER TABLE konektag.merchant_social_campaigns
  ADD COLUMN IF NOT EXISTS marketplace_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marketplace_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS channel_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS channel_ends_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE konektag.merchant_social_campaigns
    ADD CONSTRAINT merchant_social_campaign_periods_valid CHECK (
      (marketplace_starts_at IS NULL) = (marketplace_ends_at IS NULL)
      AND (channel_starts_at IS NULL) = (channel_ends_at IS NULL)
      AND (marketplace_ends_at IS NULL OR marketplace_starts_at <= marketplace_ends_at)
      AND (channel_ends_at IS NULL OR channel_starts_at <= channel_ends_at)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE konektag.merchant_social_boosts
  DROP CONSTRAINT IF EXISTS merchant_social_boosts_status_check;
ALTER TABLE konektag.merchant_social_boosts
  ADD CONSTRAINT merchant_social_boosts_status_check CHECK
  (status IN ('REQUESTED','QUOTED','PAYMENT_PENDING','PAID','CONFIGURED','BOOSTED','COMPLETED','CANCELLED'));

ALTER TABLE konektag.merchant_social_boost_targets
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'CREATED';

DO $$ BEGIN
  ALTER TABLE konektag.merchant_social_boost_targets
    ADD CONSTRAINT merchant_social_boost_target_period_valid CHECK (
      status IN ('CREATED','SCHEDULED','PUBLISHED','COMPLETED')
      AND ((starts_at IS NULL AND ends_at IS NULL) OR
           (starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at <= ends_at))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS konektag.merchant_social_boost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boost_id UUID NOT NULL REFERENCES konektag.merchant_social_boosts(id) ON DELETE CASCADE,
  target_id UUID REFERENCES konektag.merchant_social_boost_targets(id) ON DELETE CASCADE,
  actor_id UUID,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_boost_events_history
  ON konektag.merchant_social_boost_events(boost_id, created_at, id);

COMMIT;
