BEGIN;

-- GAP-024 — durable operational evidence for mandatory workers and scheduled
-- controls (P19/P20). One row per process run: startup registration, heartbeat
-- and terminal outcome with the immutable application version.
-- No credentials, tokens, connection strings, payloads, stack traces or
-- personal data are stored here.

CREATE TABLE IF NOT EXISTS konektag.process_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id      VARCHAR(64) NOT NULL,
  run_id          UUID NOT NULL,
  execution_type  VARCHAR(16) NOT NULL CHECK (execution_type IN ('worker', 'cron')),
  app_version     VARCHAR(80) NOT NULL,
  status          VARCHAR(16) NOT NULL CHECK (status IN ('STARTED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failure_code    VARCHAR(100),
  correlation_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT process_runs_terminal_consistency CHECK (
    (status IN ('SUCCEEDED', 'FAILED') AND completed_at IS NOT NULL)
    OR (status IN ('STARTED', 'RUNNING') AND completed_at IS NULL)
  ),
  CONSTRAINT process_runs_failure_code_required CHECK (
    (status = 'FAILED' AND failure_code IS NOT NULL) OR (status <> 'FAILED')
  )
);

-- One durable row per run: a run can never hold two contradictory terminal
-- records. Terminal transitions are guarded in the application layer by
-- restricting UPDATEs to rows still in a non-terminal status.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_runs_run
  ON konektag.process_runs (process_id, run_id);

-- Efficient latest-health evaluation per mandatory process.
CREATE INDEX IF NOT EXISTS idx_process_runs_latest
  ON konektag.process_runs (process_id, started_at DESC);

COMMIT;
