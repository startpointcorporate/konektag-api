-- Migration 081 : Financial operation invariants
-- Ensures final transactions have all V3 dimensions NOT NULL.
-- Adds operation_id uniqueness, command_hash, klot_allocations, and
-- conditional NOT NULL constraints for finalized operations.

BEGIN;

-- 1. Add command_hash to financial_transactions for accounting idempotency
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS command_hash VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_tx_operation_id
    ON konektag.financial_transactions (operation_id) WHERE operation_id IS NOT NULL;

-- 2. Add klot_allocations table for atomic KLot reservation/debit
CREATE TABLE IF NOT EXISTS konektag.klot_allocations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    klot_id             UUID NOT NULL REFERENCES konektag.klots(id),
    transaction_id      UUID REFERENCES konektag.financial_transactions(id),
    allocated_quantity  DECIMAL NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_klot_allocations_klot ON konektag.klot_allocations(klot_id);
CREATE INDEX IF NOT EXISTS idx_klot_allocations_tx ON konektag.klot_allocations(transaction_id);

-- 3. Add remaining_quantity to klots and a partial unique index for active allocations
ALTER TABLE konektag.klots ADD COLUMN IF NOT EXISTS remaining_quantity DECIMAL;
UPDATE konektag.klots SET remaining_quantity = quantity_k WHERE remaining_quantity IS NULL;
ALTER TABLE konektag.klots ALTER COLUMN remaining_quantity SET DEFAULT 0;

-- 4. Add source_operation_id and approval fields for reversals
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_evidence JSONB;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_approved_by UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_approved_at TIMESTAMPTZ;

-- 5. Ensure source_operation_id is a proper FK for reversals
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_financial_tx_source_operation'
    ) THEN
        ALTER TABLE konektag.financial_transactions
        ADD CONSTRAINT fk_financial_tx_source_operation
        FOREIGN KEY (source_operation_id) REFERENCES konektag.financial_transactions(id);
    END IF;
END $$;

-- 6. Add eligibility_decision to financial_transactions
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS eligibility_decision VARCHAR(30);

-- 7. Make V3 dimensions conditional NOT NULL: they are required when the
-- transaction status is final ('completed' or 'reversed'). The constraint
-- is enforced at the application level via FinancialOperationService.
-- We add a CHECK constraint for final status completeness.
DO $$ BEGIN
    ALTER TABLE konektag.financial_transactions
    ADD CONSTRAINT ck_finalized_dimensions
    CHECK (
        status NOT IN ('completed', 'reversed')
        OR (
            legal_entity_id IS NOT NULL
            AND corridor_id IS NOT NULL
            AND operation_id IS NOT NULL
            AND regulatory_profile_id IS NOT NULL
            AND currency IS NOT NULL
            AND value_date IS NOT NULL
            AND eligibility_decision IS NOT NULL
        )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 8. Make reversal fields NOT NULL when transaction_type is 'reversal'
DO $$ BEGIN
    ALTER TABLE konektag.financial_transactions
    ADD CONSTRAINT ck_reversal_fields
    CHECK (
        transaction_type != 'reversal'
        OR (
            source_operation_id IS NOT NULL
            AND reversal_reason IS NOT NULL
        )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
