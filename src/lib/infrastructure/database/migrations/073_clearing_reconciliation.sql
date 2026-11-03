-- Migration 073 : Clearing inter-societes P14/P15
-- Batches geles avec triple approbation + preuve bancaire
-- Idempotent

BEGIN;

DROP TABLE IF EXISTS konektag.clearing_batches CASCADE;

CREATE TABLE konektag.clearing_batches (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_ref               VARCHAR(100) NOT NULL UNIQUE,
    legal_entity_id         UUID NOT NULL REFERENCES konektag.legal_entities(id),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    position_count          INTEGER NOT NULL DEFAULT 0,
    net_amount              NUMERIC(20,2),
    currency                VARCHAR(10),
    status                  VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                                CHECK (status IN ('OPEN', 'FROZEN', 'APPROVED', 'SETTLED', 'REJECTED', 'CANCELLED')),
    initiated_by            UUID,
    finance_a_approved_by   UUID,
    finance_a_approved_at   TIMESTAMPTZ,
    finance_b_approved_by   UUID,
    finance_b_approved_at   TIMESTAMPTZ,
    compliance_approved_by  UUID,
    compliance_approved_at  TIMESTAMPTZ,
    bank_proof_url          TEXT,
    settled_by              UUID,
    settlement_date         DATE,
    version                 INTEGER NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_clearing_batch_ref ON konektag.clearing_batches(batch_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clearing_batch_status ON konektag.clearing_batches(status) WHERE deleted_at IS NULL;

-- Table de reconciliation quotidienne
CREATE TABLE IF NOT EXISTS konektag.daily_reconciliations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reconciliation_date DATE NOT NULL,
    gl_name             VARCHAR(50) NOT NULL,
    rail                VARCHAR(30),
    expected_balance    NUMERIC(20,2),
    actual_balance      NUMERIC(20,2),
    difference          NUMERIC(20,2),
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'MATCHED', 'MISMATCH', 'INVESTIGATING', 'RESOLVED')),
    exceptions          JSONB DEFAULT '[]',
    reconciled_by       UUID,
    reconciled_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reconciliation_date, gl_name, rail)
);

COMMIT;
