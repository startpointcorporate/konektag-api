-- Migration 033 : Accounting Outbox — file d'attente des événements comptables ERPNext
-- Idempotent

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.accounting_outbox (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    financial_transaction_id UUID NOT NULL REFERENCES konektag.financial_transactions(id),
    event_type               VARCHAR(50) NOT NULL DEFAULT 'AccountingRequested',
    payload                  JSONB NOT NULL DEFAULT '{}',
    status                   VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    attempt_count            INTEGER NOT NULL DEFAULT 0,
    max_attempts             INTEGER NOT NULL DEFAULT 10,
    next_attempt_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at          TIMESTAMPTZ,
    processed_at             TIMESTAMPTZ,
    last_error               TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index : récupérer les événements en attente de traitement
CREATE INDEX IF NOT EXISTS idx_accounting_outbox_pending
    ON konektag.accounting_outbox(next_attempt_at, created_at, id)
    WHERE status = 'pending';

-- Index : FK lookup
CREATE INDEX IF NOT EXISTS idx_accounting_outbox_tx
    ON konektag.accounting_outbox(financial_transaction_id);

COMMIT;
