-- Migration 087: non-destructive clearing and reconciliation correction.
-- Historical clearing batches and their evidence must never be recreated or dropped.

BEGIN;

ALTER TABLE konektag.clearing_batches
    ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS exception_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS value_date DATE,
    ADD COLUMN IF NOT EXISTS bank_channel VARCHAR(100),
    ADD COLUMN IF NOT EXISTS declaration_ref TEXT,
    ADD COLUMN IF NOT EXISTS cobac_justification_url TEXT;

ALTER TABLE konektag.daily_reconciliations
    ADD COLUMN IF NOT EXISTS legal_entity_id UUID REFERENCES konektag.legal_entities(id),
    ADD COLUMN IF NOT EXISTS currency VARCHAR(10),
    ADD COLUMN IF NOT EXISTS category VARCHAR(50),
    ADD COLUMN IF NOT EXISTS supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE konektag.audit_logs
    ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS entity_id UUID,
    ADD COLUMN IF NOT EXISTS changed_by VARCHAR(100),
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_clearing_batches_pair_period
    ON konektag.clearing_batches (legal_entity_id, counterparty_entity_id, period_start, period_end)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_intercompany_positions_open_pair
    ON konektag.intercompany_positions (legal_entity_a_id, legal_entity_b_id, currency, value_date)
    WHERE status = 'OPEN';

COMMIT;
