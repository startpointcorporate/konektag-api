-- Migration 080 : HTTP idempotency table
-- Creates http_idempotency_requests with per-actor key scoping,
-- command hash, status lifecycle, and response replay.

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.http_idempotency_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id          VARCHAR(200) NOT NULL,
    http_method       VARCHAR(10) NOT NULL,
    normalized_path   VARCHAR(300) NOT NULL,
    idempotency_key   VARCHAR(200) NOT NULL,
    command_hash      VARCHAR(64) NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'PROCESSING'
                          CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    response_status   INTEGER,
    response_headers  JSONB,
    response_body     TEXT,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_http_idempotency_actor_key
    ON konektag.http_idempotency_requests (actor_id, http_method, normalized_path, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_http_idempotency_status
    ON konektag.http_idempotency_requests (status, expires_at);

COMMIT;
