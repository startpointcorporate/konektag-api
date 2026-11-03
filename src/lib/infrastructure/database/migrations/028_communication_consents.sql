CREATE TABLE IF NOT EXISTS konektag.communication_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'whatsapp')),
  status VARCHAR(10) NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'denied')),
  source VARCHAR(30) NOT NULL CHECK (source IN ('onboarding', 'settings', 'unsubscribe_link', 'whatsapp_optout', 'admin')),
  ip_address VARCHAR(45),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_user_channel
  ON konektag.communication_consents(user_id, channel)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_consent_user
  ON konektag.communication_consents(user_id, status)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION konektag.update_consent_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consent_updated ON konektag.communication_consents;
CREATE TRIGGER trg_consent_updated
  BEFORE UPDATE ON konektag.communication_consents
  FOR EACH ROW EXECUTE FUNCTION konektag.update_consent_timestamp();
