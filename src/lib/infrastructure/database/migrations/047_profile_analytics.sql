-- 047_profile_analytics.sql
-- Tracks profile views, phone clicks, direction requests for merchant analytics.

CREATE TABLE IF NOT EXISTS konektag.profile_analytics (
  id          SERIAL PRIMARY KEY,
  profile_id  UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  event_type  TEXT NOT NULL CHECK (event_type IN ('view', 'phone_click', 'direction_click', 'message_sent')),
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_profile_date
  ON konektag.profile_analytics(profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_type
  ON konektag.profile_analytics(event_type, created_at DESC);
