-- Migration 082 : Acquisition, KLot, valuation, reversal
-- Ensures rail proof, KLot lifecycle, and idempotent refunds.

BEGIN;

-- 1. Add rail proof fields to financial_transactions for acquisition tracking
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_ref VARCHAR(200);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_status VARCHAR(30);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_body JSONB;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_verified_at TIMESTAMPTZ;

-- 2. Add refund_intent table for idempotent refunds
CREATE TABLE IF NOT EXISTS konektag.refund_intents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_transaction_id UUID NOT NULL REFERENCES konektag.financial_transactions(id),
    refund_reference    VARCHAR(200) NOT NULL UNIQUE,
    refund_amount       DECIMAL NOT NULL,
    currency            VARCHAR(3) NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PENDING_RECONCILIATION')),
    provider_reference  VARCHAR(200),
    reversal_transaction_id UUID REFERENCES konektag.financial_transactions(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refund_intents_source ON konektag.refund_intents(source_transaction_id);
CREATE INDEX IF NOT EXISTS idx_refund_intents_ref ON konektag.refund_intents(refund_reference);

-- 3. Add maker-checker fields for manual confirmations
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS maker_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS checker_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS maker_checked_at TIMESTAMPTZ;

-- 4. Add pending_review status for mobile money manual confirmations
-- (status already supports generic values, no schema change needed)

-- 5. Add card_batch_id to financial_transactions for card activation tracking
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS card_batch_id UUID;

-- 6. Add acquisition confirmation tracking
CREATE TABLE IF NOT EXISTS konektag.acquisition_confirmations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    confirmation_type       VARCHAR(30) NOT NULL CHECK (confirmation_type IN ('stripe_webhook', 'mobile_money_callback', 'mobile_money_manual', 'crypto_confirmation')),
    external_reference      VARCHAR(200) NOT NULL UNIQUE,
    amount                  DECIMAL NOT NULL,
    currency                VARCHAR(3) NOT NULL,
    rail_proof              JSONB,
    transaction_id          UUID REFERENCES konektag.financial_transactions(id),
    status                  VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
                                CHECK (status IN ('RECEIVED', 'VERIFIED', 'PROCESSED', 'REJECTED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_acq_confirmations_ext_ref ON konektag.acquisition_confirmations(external_reference);

-- 7. Valuation record improvements: add timestamp of valuation
ALTER TABLE konektag.valuation_records ADD COLUMN IF NOT EXISTS valuation_date TIMESTAMPTZ DEFAULT now();

COMMIT;
