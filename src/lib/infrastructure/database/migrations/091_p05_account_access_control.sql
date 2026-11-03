BEGIN;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS access_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
  CHECK (access_status IN ('ACTIVE', 'BLOCKED'));
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS access_block_reason TEXT;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS access_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS konektag.account_access_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES konektag.users(id),
  actor_id UUID NOT NULL REFERENCES konektag.users(id), action VARCHAR(10) NOT NULL CHECK (action IN ('BLOCK','UNBLOCK')),
  idempotency_key VARCHAR(255) NOT NULL UNIQUE, reason TEXT NOT NULL, keycloak_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  keycloak_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
COMMIT;
