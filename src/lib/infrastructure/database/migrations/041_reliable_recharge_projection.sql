-- 041_reliable_recharge_projection.sql
-- Migrate outbox_events to support non-UUID aggregate references
-- Add recharge-specific infrastructure for reliable CQRS projection

ALTER TABLE konektag.outbox_events
  ADD COLUMN IF NOT EXISTS aggregate_ref VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_ref
  ON konektag.outbox_events(aggregate_ref)
  WHERE aggregate_ref IS NOT NULL;

-- Recharge-specific outbox index for projection queries
CREATE INDEX IF NOT EXISTS idx_outbox_recharge_projection
  ON konektag.outbox_events(event_type, created_at)
  WHERE event_type LIKE 'Recharge%' AND processed_at IS NULL;

-- Add projection metadata to recharge_read_model
ALTER TABLE konektag.recharge_read_model
  ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_event_id UUID,
  ADD COLUMN IF NOT EXISTS projected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rrm_projection
  ON konektag.recharge_read_model(projection_version, projected_at)
  WHERE deleted_at IS NULL;

-- Add unique constraint for idempotent projection (prevent duplicate events)
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotent_recharge
  ON konektag.outbox_events(aggregate_ref, event_type, event_version)
  WHERE aggregate_ref IS NOT NULL AND event_type LIKE 'Recharge%';
