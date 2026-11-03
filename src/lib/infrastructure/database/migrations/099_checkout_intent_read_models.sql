-- Migration 099: Persisted QR and payment-link read models.
BEGIN;

-- Corrective baseline: some production environments recorded migration 083
-- without retaining its checkout_intents table. Recreate the original contract
-- non-destructively before extending it.
CREATE TABLE IF NOT EXISTS konektag.checkout_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(64) NOT NULL,
  merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id),
  amount DECIMAL NOT NULL,
  currency VARCHAR(3) NOT NULL,
  service_description TEXT,
  quote_valuation JSONB,
  regulatory_profile_id UUID REFERENCES konektag.regulatory_profiles(id),
  klot_id UUID REFERENCES konektag.klots(id),
  allocation_rule JSONB,
  expiration TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ISSUED'
    CHECK (status IN ('ISSUED', 'PROCESSING', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
  operation_id UUID,
  usage_unique BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_token_hash ON konektag.checkout_intents(token_hash);
CREATE INDEX IF NOT EXISTS idx_checkout_merchant ON konektag.checkout_intents(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_checkout_status ON konektag.checkout_intents(status);

ALTER TABLE konektag.checkout_intents
  ALTER COLUMN merchant_profile_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'qr',
  ADD COLUMN IF NOT EXISTS public_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS terminal VARCHAR(255),
  ADD COLUMN IF NOT EXISTS qr_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS payer_user_id UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS financial_transaction_id UUID REFERENCES konektag.financial_transactions(id),
  ADD COLUMN IF NOT EXISTS payer_identity VARCHAR(500),
  ADD COLUMN IF NOT EXISTS external_transaction_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_public_id ON konektag.checkout_intents(public_id);
CREATE INDEX IF NOT EXISTS idx_checkout_owner ON konektag.checkout_intents(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_payer ON konektag.checkout_intents(payer_user_id, consumed_at DESC);

ALTER TABLE konektag.checkout_intents DROP CONSTRAINT IF EXISTS checkout_intents_source_type_check;
ALTER TABLE konektag.checkout_intents ADD CONSTRAINT checkout_intents_source_type_check
  CHECK (source_type IN ('qr', 'payment_link'));
ALTER TABLE konektag.checkout_intents DROP CONSTRAINT IF EXISTS checkout_intents_owner_check;
ALTER TABLE konektag.checkout_intents ADD CONSTRAINT checkout_intents_owner_check
  CHECK ((merchant_profile_id IS NOT NULL) <> (owner_user_id IS NOT NULL));
ALTER TABLE konektag.checkout_intents DROP CONSTRAINT IF EXISTS checkout_intents_status_check;
ALTER TABLE konektag.checkout_intents ADD CONSTRAINT checkout_intents_status_check
  CHECK (status IN ('ISSUED', 'PROCESSING', 'CONSUMED', 'EXPIRED', 'CANCELLED'));

COMMIT;
