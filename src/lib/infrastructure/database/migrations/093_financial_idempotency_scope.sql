-- Financial idempotency scopes are additive. Legacy generic HTTP records keep
-- their old uniqueness rule; only fully populated financial scopes use this index.
BEGIN;

ALTER TABLE konektag.http_idempotency_requests
  ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS legal_entity_id UUID REFERENCES konektag.legal_entities(id),
  ADD COLUMN IF NOT EXISTS route_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);

ALTER TABLE konektag.http_idempotency_requests
  DROP CONSTRAINT IF EXISTS http_idempotency_actor_type_check;
ALTER TABLE konektag.http_idempotency_requests
  ADD CONSTRAINT http_idempotency_actor_type_check
   CHECK (actor_type IS NULL OR actor_type IN ('USER', 'MERCHANT', 'ADMIN', 'SERVICE'));

-- The original global uniqueness rule would still collide with a scoped
-- financial record. Keep it for legacy records only.
DROP INDEX IF EXISTS konektag.uq_http_idempotency_actor_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_http_idempotency_actor_key
  ON konektag.http_idempotency_requests (actor_id, http_method, normalized_path, idempotency_key)
  WHERE actor_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_idempotency_scope
  ON konektag.http_idempotency_requests
    (actor_type, actor_id, legal_entity_id, route_key, idempotency_key)
  WHERE actor_type IS NOT NULL
    AND legal_entity_id IS NOT NULL
    AND route_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_financial_idempotency_scope_lookup
  ON konektag.http_idempotency_requests
    (actor_type, actor_id, legal_entity_id, route_key, expires_at)
  WHERE actor_type IS NOT NULL;

COMMIT;
