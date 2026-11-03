-- Migration 075 : Finalisation P02-P20
-- funding_transaction_id, disputes, COBAC, re-screening job

BEGIN;

-- P02/P03 : funding_transaction_id pour acquisitions
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS funding_transaction_id VARCHAR(200);

-- P13 : Table des litiges/reclamations
CREATE TABLE IF NOT EXISTS konektag.disputes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_ref     VARCHAR(100) NOT NULL UNIQUE,
    user_id         UUID NOT NULL REFERENCES konektag.users(id),
    operation_id    UUID REFERENCES konektag.financial_transactions(id),
    dispute_type    VARCHAR(30) NOT NULL
                        CHECK (dispute_type IN ('litige_commercial', 'incident_psp', 'chargeback', 'remboursement_legal')),
    status          VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'INVESTIGATING', 'RESOLVED_APPROVED', 'RESOLVED_REFUNDED', 'CLOSED')),
    description     TEXT,
    sla_due_date    DATE,
    resolution      TEXT,
    resolved_by     UUID,
    resolved_at     TIMESTAMPTZ,
    evidence        JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- P15 : Justificatif COBAC pour reglements Congo
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS cobac_justification_url TEXT;
ALTER TABLE konektag.clearing_batches ADD COLUMN IF NOT EXISTS declaration_ref VARCHAR(200);

-- P16 : Champ pour le resultat de reconciliation
ALTER TABLE konektag.daily_reconciliations ADD COLUMN IF NOT EXISTS notes TEXT;

COMMIT;
