-- 043_refinements_final.sql
-- Renames, workflow split, checksums, timeline view.
-- All table renames use ALTER TABLE ... RENAME which preserves
-- data, FKs, indexes, and constraints (they are renamed alongside).

-- 1. Rename recharge_read_model → recharge_projection (idempotent :
-- 040 recrée recharge_read_model (vide) à chaque boot via CREATE TABLE IF NOT EXISTS)
DO $$
DECLARE
  has_old boolean;
  has_new boolean;
  old_has_rows boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'konektag' AND tablename = 'recharge_read_model') INTO has_old;
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'konektag' AND tablename = 'recharge_projection') INTO has_new;
  IF has_old AND NOT has_new THEN
    ALTER TABLE konektag.recharge_read_model RENAME TO recharge_projection;
  ELSIF has_old AND has_new THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM konektag.recharge_read_model)' INTO old_has_rows;
    IF NOT old_has_rows THEN
      DROP TABLE konektag.recharge_read_model;
    END IF;
  END IF;
END $$;
ALTER INDEX IF EXISTS konektag.idx_rrm_workflow_state RENAME TO idx_rp_workflow_state;
ALTER INDEX IF EXISTS konektag.idx_rrm_payment_method RENAME TO idx_rp_payment_method;
ALTER INDEX IF EXISTS konektag.idx_rrm_payment_provider RENAME TO idx_rp_payment_provider;
ALTER INDEX IF EXISTS konektag.idx_rrm_currency RENAME TO idx_rp_currency;
ALTER INDEX IF EXISTS konektag.idx_rrm_country RENAME TO idx_rp_country;
ALTER INDEX IF EXISTS konektag.idx_rrm_created_at RENAME TO idx_rp_created_at;
ALTER INDEX IF EXISTS konektag.idx_rrm_keycloak_id RENAME TO idx_rp_keycloak_id;
ALTER INDEX IF EXISTS konektag.idx_rrm_anomaly RENAME TO idx_rp_anomaly;
ALTER INDEX IF EXISTS konektag.idx_rrm_credited RENAME TO idx_rp_credited;
ALTER INDEX IF EXISTS konektag.idx_rrm_ref RENAME TO idx_rp_ref;
ALTER INDEX IF EXISTS konektag.idx_rrm_name RENAME TO idx_rp_name;
ALTER INDEX IF EXISTS konektag.idx_rrm_user_email RENAME TO idx_rp_user_email;
ALTER INDEX IF EXISTS konektag.idx_rrm_projection RENAME TO idx_rp_projection;
ALTER INDEX IF EXISTS konektag.idx_rrm_payment_method RENAME TO idx_rp_payment_method;
ALTER INDEX IF EXISTS konektag.idx_rrm_payment_provider RENAME TO idx_rp_payment_provider;

-- 2. Rename external_operation_journal → integration_operations (idempotent :
-- 042 recrée external_operation_journal (vide) à chaque boot via CREATE TABLE IF NOT EXISTS)
DO $$
DECLARE
  has_old boolean;
  has_new boolean;
  old_has_rows boolean;
  has_old_col boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'konektag' AND tablename = 'external_operation_journal') INTO has_old;
  SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'konektag' AND tablename = 'integration_operations') INTO has_new;
  IF has_old AND NOT has_new THEN
    ALTER TABLE konektag.external_operation_journal RENAME TO integration_operations;
  ELSIF has_old AND has_new THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM konektag.external_operation_journal)' INTO old_has_rows;
    IF NOT old_has_rows THEN
      DROP TABLE konektag.external_operation_journal;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'konektag' AND table_name = 'integration_operations' AND column_name = 'operation_type'
  ) INTO has_old_col;
  IF has_new AND has_old_col THEN
    ALTER TABLE konektag.integration_operations RENAME COLUMN operation_type TO integration_type;
  END IF;
END $$;
ALTER INDEX IF EXISTS konektag.idx_eoj_aggregate RENAME TO idx_io_aggregate;
ALTER INDEX IF EXISTS konektag.idx_eoj_status RENAME TO idx_io_status;
ALTER INDEX IF EXISTS konektag.idx_eoj_idempotent RENAME TO idx_io_idempotent;
ALTER INDEX IF EXISTS konektag.idx_eoj_created RENAME TO idx_io_created;

-- 3. Split single workflow_state into three orthogonal dimensions
-- First convert the enum column to plain VARCHAR to allow new values
ALTER TABLE konektag.recharge_projection
  ALTER COLUMN workflow_state TYPE VARCHAR(30) USING workflow_state::text;

-- recharge_status: the lifecycle of the recharge request itself
-- provider_status: the status reported by the external payment provider
-- ledger_status: the status of the accounting impact
ALTER TABLE konektag.recharge_projection
  ADD COLUMN IF NOT EXISTS recharge_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS provider_status_detail VARCHAR(30),
  ADD COLUMN IF NOT EXISTS ledger_status VARCHAR(30) NOT NULL DEFAULT 'not_posted';

-- Backfill: migrate existing workflow_state into recharge_status
UPDATE konektag.recharge_projection
  SET recharge_status = CASE
    WHEN workflow_state::text IN ('pending','created') THEN 'pending'
    WHEN workflow_state::text IN ('submitted_to_provider','provider_accepted','waiting_settlement','settled','credited_ledger') THEN 'confirmed'
    WHEN workflow_state::text = 'completed' THEN 'confirmed'
    WHEN workflow_state::text = 'reversed' THEN 'reversed'
    WHEN workflow_state::text = 'failed' THEN 'failed'
    ELSE 'pending'
  END,
  ledger_status = CASE
    WHEN credited_amount IS NOT NULL THEN 'posted'
    ELSE 'not_posted'
  END,
  provider_status_detail = CASE
    WHEN workflow_state::text = 'submitted_to_provider' THEN 'submitted'
    WHEN workflow_state::text = 'provider_accepted' THEN 'accepted'
    WHEN workflow_state::text IN ('waiting_settlement','settled') THEN 'pending_settlement'
    WHEN workflow_state::text = 'credited_ledger' THEN 'completed'
    ELSE provider_status_detail
  END;

-- Keep workflow_state for backward compatibility but deprecate
-- (the backoffice queries will switch to recharge_status)

-- Keep workflow_state for backward compatibility but deprecate
-- (the backoffice queries will switch to recharge_status)

-- 4. Add projection_checksum with version
ALTER TABLE konektag.recharge_projection
  ADD COLUMN IF NOT EXISTS projection_checksum VARCHAR(64),
  ADD COLUMN IF NOT EXISTS checksum_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS causation_id UUID;

-- 5. Add causation_id to outbox_events
ALTER TABLE konektag.outbox_events
  ADD COLUMN IF NOT EXISTS causation_id UUID;

CREATE INDEX IF NOT EXISTS idx_outbox_causation ON konektag.outbox_events(causation_id) WHERE causation_id IS NOT NULL;

-- 6. Display-only provider workflow hints (NOT used for transition rules)
-- Financial transition rules remain in versioned, tested TypeScript code.
CREATE TABLE IF NOT EXISTS konektag.provider_workflow_hints (
  provider_code  VARCHAR(30) PRIMARY KEY REFERENCES konektag.payment_providers(code),
  display_steps  VARCHAR(30)[] NOT NULL DEFAULT '{}',
  description    TEXT
);

INSERT INTO konektag.provider_workflow_hints (provider_code, display_steps, description) VALUES
  ('STRIPE',     ARRAY['submitted_to_provider','provider_accepted','credited_ledger','completed'], 'Carte bancaire — auto-confirmed'),
  ('GOOGLE_PAY', ARRAY['submitted_to_provider','provider_accepted','credited_ledger','completed'], 'Google Pay — auto-confirmed'),
  ('APPLE_PAY',  ARRAY['submitted_to_provider','provider_accepted','credited_ledger','completed'], 'Apple Pay — auto-confirmed'),
  ('MTN',        ARRAY['submitted_to_provider','provider_accepted','waiting_settlement','credited_ledger','completed'], 'Mobile Money — manual confirmation'),
  ('ORANGE',     ARRAY['submitted_to_provider','provider_accepted','waiting_settlement','credited_ledger','completed'], 'Mobile Money — manual confirmation'),
  ('AIRTEL',     ARRAY['submitted_to_provider','provider_accepted','waiting_settlement','credited_ledger','completed'], 'Mobile Money — manual confirmation'),
  ('USDT_TRC20', ARRAY['submitted_to_provider','provider_accepted','waiting_settlement','credited_ledger','completed'], 'Crypto — on-chain confirmation')
ON CONFLICT (provider_code) DO NOTHING;

-- 7. RechargeTimeline functional view
-- This is a read-only view combining multiple sources for operational timeline display.
-- Missing sources (documented): integration_operations, dead_letters, reconciliation events.
CREATE OR REPLACE VIEW konektag.recharge_timeline AS
SELECT
  'domain_event' AS source_type,
  e.id AS source_id,
  e.event_type AS action,
  e.aggregate_ref AS aggregate_ref,
  e.correlation_id,
  e.causation_id,
  e.created_at AS occurred_at,
  e.payload->>'reason' AS reason,
  NULL::uuid AS admin_id
FROM konektag.outbox_events e
WHERE e.event_type LIKE 'Recharge%'

UNION ALL

SELECT
  'admin_action' AS source_type,
  a.id AS source_id,
  a.action_type AS action,
  a.target_id AS aggregate_ref,
  NULL::uuid AS correlation_id,
  NULL::uuid AS causation_id,
  a.created_at AS occurred_at,
  a.reason,
  a.admin_id
FROM konektag.admin_actions a

UNION ALL

SELECT
  'ledger' AS source_type,
  l.id AS source_id,
  'Ledger_' || l.entry_side AS action,
  l.document_ref AS aggregate_ref,
  NULL::uuid AS correlation_id,
  NULL::uuid AS causation_id,
  l.created_at AS occurred_at,
  l.description AS reason,
  NULL::uuid AS admin_id
FROM konektag.ledger_entries l
WHERE l.document_type = 'Recharge'

ORDER BY occurred_at ASC;

COMMENT ON VIEW konektag.recharge_timeline IS
  'Operational timeline for recharge lifecycle. Sources included: outbox_events (domain events), admin_actions, ledger_entries. Sources NOT included (planned for separate views): integration_operations, outbox_dead_letters.';
