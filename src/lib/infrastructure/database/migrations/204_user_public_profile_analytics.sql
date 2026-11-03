-- USER_PROFILE analytics: views and explicit share actions.
CREATE TABLE IF NOT EXISTS konektag.user_public_profile_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
 event_type VARCHAR(16) NOT NULL CHECK(event_type IN ('view','share')),
 visitor_hash VARCHAR(64),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_profile_events_profile_type ON konektag.user_public_profile_events(profile_user_id,event_type,created_at DESC);
