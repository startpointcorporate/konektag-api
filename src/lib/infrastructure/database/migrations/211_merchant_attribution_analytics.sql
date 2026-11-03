-- Attribution metadata for merchant acquisition, sharing and business impact.
ALTER TABLE konektag.profile_analytics
  ADD COLUMN IF NOT EXISTS session_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS share_id UUID,
  ADD COLUMN IF NOT EXISTS activity_code VARCHAR(30),
  ADD COLUMN IF NOT EXISTS channel VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source VARCHAR(60),
  ADD COLUMN IF NOT EXISTS campaign VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_profile_analytics_share_id ON konektag.profile_analytics(share_id) WHERE share_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_analytics_attribution ON konektag.profile_analytics(profile_id, source, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_analytics_session ON konektag.profile_analytics(profile_id, session_id, created_at DESC) WHERE session_id IS NOT NULL;
