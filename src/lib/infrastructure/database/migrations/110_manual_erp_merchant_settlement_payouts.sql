BEGIN;

ALTER TABLE konektag.merchant_settlement_payouts
  ADD COLUMN IF NOT EXISTS payout_mode VARCHAR(32) NOT NULL DEFAULT 'MANUAL_ERP'
    CHECK (payout_mode IN ('MANUAL_ERP', 'AUTOMATED_V2')),
  ADD COLUMN IF NOT EXISTS manual_workflow_status VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN IF NOT EXISTS value_date DATE,
  ADD COLUMN IF NOT EXISTS proof_document BYTEA,
  ADD COLUMN IF NOT EXISTS proof_filename VARCHAR(255),
  ADD COLUMN IF NOT EXISTS proof_submitted_by UUID,
  ADD COLUMN IF NOT EXISTS proof_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proof_verified_by UUID,
  ADD COLUMN IF NOT EXISTS proof_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. The catalog guard makes this
-- additive and safe for a retry after a partial external schema setup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'konektag.merchant_settlement_payouts'::regclass
      AND conname = 'merchant_settlement_payouts_manual_workflow_status_check'
  ) THEN
    ALTER TABLE konektag.merchant_settlement_payouts
      ADD CONSTRAINT merchant_settlement_payouts_manual_workflow_status_check
      CHECK (manual_workflow_status IN ('NOT_APPLICABLE', 'BANK_PENDING', 'AWAITING_VERIFICATION', 'REJECTED', 'CONFIRMED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS konektag.merchant_settlement_payout_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id UUID NOT NULL REFERENCES konektag.merchant_settlement_payouts(id),
  operator_reference VARCHAR(255) NOT NULL,
  value_date DATE NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL,
  document BYTEA NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  submitted_by UUID NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_status VARCHAR(32) NOT NULL DEFAULT 'AWAITING_VERIFICATION'
    CHECK (verification_status IN ('AWAITING_VERIFICATION', 'REJECTED', 'VERIFIED')),
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlement_payout_proofs_payout ON konektag.merchant_settlement_payout_proofs(payout_id, submitted_at DESC);

COMMIT;
