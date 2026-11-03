-- Migration 085 : Clearing, B2B settlements, reconciliation
-- Enhanced clearing lifecycle, snapshot positions, B2B proof requirements.

BEGIN;

-- 1. Add clearing_batch_positions snapshot table
CREATE TABLE IF NOT EXISTS konektag.clearing_batch_positions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clearing_batch_id   UUID NOT NULL REFERENCES konektag.clearing_batches(id),
    position_id         UUID NOT NULL REFERENCES konektag.intercompany_positions(id),
    amount              DECIMAL NOT NULL,
    currency            VARCHAR(3) NOT NULL,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(clearing_batch_id, position_id)
);
CREATE INDEX IF NOT EXISTS idx_cbp_batch ON konektag.clearing_batch_positions(clearing_batch_id);

-- 2. Add B2B settlement fields to clearing_batches
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS counterparty_entity_id UUID;
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS b2b_profile_id UUID REFERENCES konektag.b2b_settlement_profiles(id);
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS netting_allowed BOOLEAN DEFAULT false;
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS fx_rate DECIMAL;
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS fx_spread_bps INTEGER;

-- 3. Add settlement_status lifecycle to clearing_batches (if not already present)
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'konektag' AND table_name = 'clearing_batches' AND column_name = 'status'
    ) THEN
        ALTER TABLE konektag.clearing_batches DROP CONSTRAINT IF EXISTS clearing_batches_status_check;
        ALTER TABLE konektag.clearing_batches ADD CONSTRAINT clearing_batches_status_check
            CHECK (status IN ('OPEN', 'FROZEN', 'RECONCILED', 'CALCULATED', 'APPROVED', 'BANK_PENDING', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED'));
    END IF;
END $$;

-- 4. Link clearing_batches to financial_transactions for settlement posting
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS clearing_batch_id UUID;

-- 5. Daily reconciliation improvements
ALTER TABLE konektag.daily_reconciliations ADD COLUMN IF NOT EXISTS blocks_settlement BOOLEAN DEFAULT false;
ALTER TABLE konektag.daily_reconciliations ADD COLUMN IF NOT EXISTS blocks_clearing BOOLEAN DEFAULT false;

COMMIT;
