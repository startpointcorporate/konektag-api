-- Migration 059: agent_enabled flag on merchant_profiles
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_agent ON konektag.merchant_profiles(agent_enabled) WHERE agent_enabled = true AND deleted_at IS NULL;
