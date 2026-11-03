-- PAY-01 PR1: references from the QR intent to the canonical CORE transaction.
-- Historical migrations remain immutable.
ALTER TABLE konektag.checkout_intents
  ADD COLUMN IF NOT EXISTS qr_request_id UUID,
  ADD COLUMN IF NOT EXISTS qr_beneficiary_type TEXT,
  ADD COLUMN IF NOT EXISTS qr_beneficiary_id UUID,
  ADD COLUMN IF NOT EXISTS qr_issuer_device_id UUID,
  ADD COLUMN IF NOT EXISTS qr_key_id UUID,
  ADD COLUMN IF NOT EXISTS qr_key_version BIGINT,
  ADD COLUMN IF NOT EXISTS core_transaction_id UUID;

ALTER TABLE konektag.core_transactions
  ALTER COLUMN merchant_profile_id DROP NOT NULL;

ALTER TABLE konektag.checkout_intents
  ADD CONSTRAINT checkout_intents_qr_beneficiary_type_ck
  CHECK (qr_beneficiary_type IS NULL OR qr_beneficiary_type IN ('USER', 'MERCHANT'));

CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_qr_request_id_uq
  ON konektag.checkout_intents(qr_request_id)
  WHERE qr_request_id IS NOT NULL AND source_type = 'qr';

CREATE INDEX IF NOT EXISTS checkout_intents_qr_beneficiary_idx
  ON konektag.checkout_intents(qr_beneficiary_type, qr_beneficiary_id)
  WHERE source_type = 'qr';

CREATE UNIQUE INDEX IF NOT EXISTS core_transactions_qr_request_uq
  ON konektag.core_transactions(customer_user_id, request_key)
  WHERE request_key LIKE 'QR:%';
