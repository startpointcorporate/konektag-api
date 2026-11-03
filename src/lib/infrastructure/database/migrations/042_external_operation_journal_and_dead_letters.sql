-- 042_external_operation_journal_and_dead_letters.sql
-- Track coordination with external systems (ERPNext, payment providers)
-- + dead letter queue for unrecoverable events
-- + blocked events tracking for out-of-sequence handling

-- 1. External Operation Journal
CREATE TABLE IF NOT EXISTS konektag.external_operation_journal (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type    VARCHAR(50) NOT NULL,        -- 'erpnext_recharge_create', 'ledger_credit', etc.
  aggregate_type    VARCHAR(50) NOT NULL DEFAULT 'Recharge',
  aggregate_ref     VARCHAR(255) NOT NULL,       -- recharge_name or other business ref
  idempotency_key   VARCHAR(255) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64),               -- SHA-256 of request params for dedup
  external_reference VARCHAR(255),               -- ERPNext name, Stripe PI, etc.
  status            VARCHAR(30) NOT NULL DEFAULT 'prepared'
                    CHECK (status IN (
                      'prepared', 'external_call_started', 'external_call_succeeded',
                      'outbox_pending', 'completed', 'failed',
                      'reconciliation_required'
                    )),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  outbox_event_id   UUID REFERENCES konektag.outbox_events(id),
  last_error        TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eoj_aggregate   ON konektag.external_operation_journal(aggregate_type, aggregate_ref);
CREATE INDEX IF NOT EXISTS idx_eoj_status      ON konektag.external_operation_journal(status) WHERE status IN ('prepared', 'reconciliation_required');
CREATE INDEX IF NOT EXISTS idx_eoj_idempotent  ON konektag.external_operation_journal(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_eoj_created     ON konektag.external_operation_journal(created_at DESC);

-- 2. Dead Letter Queue for permanently failed projection events
CREATE TABLE IF NOT EXISTS konektag.outbox_dead_letters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_event_id UUID,
  event_type        VARCHAR(100) NOT NULL,
  aggregate_type    VARCHAR(50) NOT NULL,
  aggregate_ref     VARCHAR(255),
  payload           JSONB NOT NULL,
  failure_reason    TEXT NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  first_failed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead_lettered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES konektag.users(id),
  resolution_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_odl_unresolved ON konektag.outbox_dead_letters(dead_lettered_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_odl_aggregate  ON konektag.outbox_dead_letters(aggregate_type, aggregate_ref);

-- 3. Add blocked tracking columns to outbox_events
ALTER TABLE konektag.outbox_events
  ADD COLUMN IF NOT EXISTS blocked_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_blocked
  ON konektag.outbox_events(next_retry_at, created_at, id)
  WHERE blocked_reason IS NOT NULL AND processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_retryable
  ON konektag.outbox_events(next_retry_at, created_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND blocked_reason IS NULL;
