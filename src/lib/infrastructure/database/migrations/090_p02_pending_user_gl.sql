-- P02: a verified external collection must survive a downstream GL failure so it
-- can be resumed without accepting the proof twice or creating a valued orphan KLot.
BEGIN;

-- Some production schemas recorded migration 082 before this table existed.
-- Recreate its original shape before applying the regulated P02 extension.
CREATE TABLE IF NOT EXISTS konektag.acquisition_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_type VARCHAR(30) NOT NULL CHECK (confirmation_type IN ('stripe_webhook', 'mobile_money_callback', 'mobile_money_manual', 'crypto_confirmation')),
  external_reference VARCHAR(200) NOT NULL UNIQUE,
  amount DECIMAL NOT NULL,
  currency VARCHAR(3) NOT NULL,
  rail_proof JSONB,
  transaction_id UUID REFERENCES konektag.financial_transactions(id),
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'VERIFIED', 'PROCESSED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_acq_confirmations_ext_ref
  ON konektag.acquisition_confirmations(external_reference);

ALTER TABLE konektag.acquisition_confirmations
  ADD COLUMN IF NOT EXISTS operation_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The original column was VARCHAR(20); the regulated pending state is longer.
-- Widening it is non-destructive and must precede the data migration below.
ALTER TABLE konektag.acquisition_confirmations
  ALTER COLUMN status TYPE VARCHAR(40);

-- Existing verified-but-unprocessed confirmations become resumable too.
UPDATE konektag.acquisition_confirmations
SET status = 'CONFIRMED_PENDING_USER_GL',
    operation_id = COALESCE(operation_id, 'ACQ-' || gen_random_uuid()::text),
    idempotency_key = COALESCE(idempotency_key, 'acquisition:' || external_reference)
WHERE status IN ('RECEIVED', 'VERIFIED');

ALTER TABLE konektag.acquisition_confirmations
  DROP CONSTRAINT IF EXISTS acquisition_confirmations_status_check;
ALTER TABLE konektag.acquisition_confirmations
  ADD CONSTRAINT acquisition_confirmations_status_check
  CHECK (status IN ('RECEIVED', 'VERIFIED', 'CONFIRMED_PENDING_USER_GL', 'PROCESSED', 'REJECTED'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_confirmations_operation_id
  ON konektag.acquisition_confirmations(operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_confirmations_idempotency_key
  ON konektag.acquisition_confirmations(idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMIT;
