BEGIN;

CREATE TABLE IF NOT EXISTS konektag.growth_shareable_contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES konektag.merchant_media(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('profile', 'offer', 'promotion')),
  target_id UUID,
  channel TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES konektag.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((target_type = 'profile' AND target_id = merchant_profile_id) OR target_type <> 'profile')
);
CREATE INDEX IF NOT EXISTS idx_growth_contents_merchant
  ON konektag.growth_shareable_contents(merchant_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS konektag.growth_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('profile', 'offer', 'promotion', 'checkout', 'campaign', 'content')),
  target_id UUID,
  target_ref TEXT,
  channel TEXT NOT NULL DEFAULT 'link',
  attribution_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES konektag.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_id IS NOT NULL OR target_ref IS NOT NULL),
  CHECK (target_type = 'checkout' OR target_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_growth_destinations_merchant
  ON konektag.growth_destinations(merchant_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_destinations_attribution
  ON konektag.growth_destinations(attribution_id);

CREATE TABLE IF NOT EXISTS konektag.growth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE RESTRICT,
  destination_id UUID REFERENCES konektag.growth_destinations(id) ON DELETE RESTRICT,
  content_id UUID REFERENCES konektag.growth_shareable_contents(id) ON DELETE RESTRICT,
  attribution_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN ('smart_qr_scan', 'destination_opened', 'offer_clicked', 'promotion_clicked', 'content_shared', 'conversion')),
  channel TEXT,
  user_id UUID REFERENCES konektag.users(id),
  promotion_id UUID REFERENCES konektag.promotions(id) ON DELETE RESTRICT,
  offer_id UUID REFERENCES konektag.merchant_products(id) ON DELETE RESTRICT,
  campaign_id UUID REFERENCES konektag.activation_campaigns(id) ON DELETE RESTRICT,
  conversion_reference TEXT,
  event_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_profile_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_growth_events_merchant_date
  ON konektag.growth_events(merchant_profile_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_attribution
  ON konektag.growth_events(attribution_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION konektag.reject_growth_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GROWTH_EVENT_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS growth_events_immutable ON konektag.growth_events;
CREATE TRIGGER growth_events_immutable
  BEFORE UPDATE OR DELETE ON konektag.growth_events
  FOR EACH ROW EXECUTE FUNCTION konektag.reject_growth_event_mutation();

ALTER TABLE konektag.loyalty_transactions
  ADD CONSTRAINT loyalty_transactions_reference_unique
  UNIQUE (user_id, reason, reference);

COMMIT;
