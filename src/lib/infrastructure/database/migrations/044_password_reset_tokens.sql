-- 044_password_reset_tokens.sql
CREATE TABLE IF NOT EXISTS konektag.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_id UUID NOT NULL,
  email_hash VARCHAR(64) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prt_token_hash ON konektag.password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_prt_keycloak ON konektag.password_reset_tokens(keycloak_id);
