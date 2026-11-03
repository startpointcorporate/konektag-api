-- Personal API credentials reference an existing Konektag / Keycloak user.
-- The API secret is never stored in plaintext.
CREATE TABLE konektag.user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL CHECK (length(trim(label)) > 0),
  api_key VARCHAR(36) NOT NULL UNIQUE CHECK (api_key ~ '^ktg_[a-f0-9]{32}$'),
  secret_hash CHAR(64) NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX user_api_keys_owner_idx ON konektag.user_api_keys(user_id, created_at DESC);

-- Reuse the explicitly configured runtime role; never guess or grant to PUBLIC.
DO $$
DECLARE runtime_role TEXT := current_setting('konektag.runtime_role', true);
BEGIN
  IF COALESCE(runtime_role, '') <> '' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON konektag.user_api_keys TO %I', runtime_role);
  END IF;
END;
$$;
