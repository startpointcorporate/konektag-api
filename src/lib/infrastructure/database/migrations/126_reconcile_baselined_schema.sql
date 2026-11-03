-- Reconcile schemas where 001-083 were recorded without their SQL running.
-- This migration is deliberately state-aware: each object is created only when
-- PostgreSQL does not already expose the final contract used by the application.

BEGIN;

-- 020, 028 and 030: small operational tables skipped by the historical baseline.
CREATE TABLE IF NOT EXISTS konektag.transfer_confirm_tokens (
  token VARCHAR(64) PRIMARY KEY,
  transfer_name VARCHAR(64) NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_confirm_tokens_token ON konektag.transfer_confirm_tokens(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_confirm_tokens_transfer ON konektag.transfer_confirm_tokens(transfer_name);

CREATE TABLE IF NOT EXISTS konektag.communication_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'whatsapp')),
  status VARCHAR(10) NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'denied')),
  source VARCHAR(30) NOT NULL CHECK (source IN ('onboarding', 'settings', 'unsubscribe_link', 'whatsapp_optout', 'admin')),
  ip_address VARCHAR(45),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_user_channel ON konektag.communication_consents(user_id, channel) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_consent_user ON konektag.communication_consents(user_id, status) WHERE deleted_at IS NULL;
CREATE OR REPLACE FUNCTION konektag.update_consent_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_consent_updated ON konektag.communication_consents;
CREATE TRIGGER trg_consent_updated BEFORE UPDATE ON konektag.communication_consents
  FOR EACH ROW EXECUTE FUNCTION konektag.update_consent_timestamp();

CREATE TABLE IF NOT EXISTS konektag.referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(code)
);
CREATE TABLE IF NOT EXISTS konektag.referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES konektag.referral_codes(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  reward_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending', 'rewarded', 'expired')),
  reward_points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referred_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON konektag.referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_code ON konektag.referral_redemptions(code_id);

-- 062: merchant certification is additive and leaves existing merchant data intact.
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS certification_status VARCHAR(20) NOT NULL DEFAULT 'NON_CERTIFIED';
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS certification_submitted_at TIMESTAMPTZ;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS certification_reviewed_at TIMESTAMPTZ;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS certification_reviewed_by UUID;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS rating DECIMAL(3,1);
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS photo_urls JSONB;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS has_delivery BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS has_takeout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS has_dine_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(200);
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS opening_hours_json JSONB;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS price_range VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_certification ON konektag.merchant_profiles(certification_status);
CREATE TABLE IF NOT EXISTS konektag.merchant_certification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL CHECK (document_type IN ('business_document', 'manager_identity', 'establishment_photo')),
  title VARCHAR(200), file_url VARCHAR(500) NOT NULL, file_key VARCHAR(500), mime_type VARCHAR(100),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cert_docs_profile ON konektag.merchant_certification_documents(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_cert_docs_type ON konektag.merchant_certification_documents(merchant_profile_id, document_type);
CREATE OR REPLACE FUNCTION konektag.count_merchant_received_transactions(p_merchant_profile_id UUID) RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE v_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count FROM konektag.financial_transactions
  WHERE merchant_profile_id = p_merchant_profile_id AND status = 'completed' AND transaction_type IN ('qr_payment', 'api_payment');
  RETURN v_count;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_fin_tx_merchant_count ON konektag.financial_transactions(merchant_profile_id, status)
  WHERE merchant_profile_id IS NOT NULL AND status = 'completed';

-- 032, 081 and 082: financial primitives used by AcquisitionService.
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS command_hash VARCHAR(64);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_evidence JSONB;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_approved_by UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS reversal_approved_at TIMESTAMPTZ;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS eligibility_decision VARCHAR(30);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_ref VARCHAR(200);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_status VARCHAR(30);
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_body JSONB;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS rail_proof_verified_at TIMESTAMPTZ;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS maker_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS checker_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS maker_checked_at TIMESTAMPTZ;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS card_batch_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_depth INTEGER DEFAULT 0;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_origin_user_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_chain_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_chain_position INTEGER DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_tx_operation_id ON konektag.financial_transactions(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_status ON konektag.financial_transactions(status);
CREATE INDEX IF NOT EXISTS idx_fin_tx_accounting ON konektag.financial_transactions(accounting_status) WHERE accounting_status IN ('pending', 'processing', 'failed');
CREATE INDEX IF NOT EXISTS idx_fin_tx_idempotency ON konektag.financial_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_fin_tx_business_ref ON konektag.financial_transactions(business_reference);

ALTER TABLE konektag.klots ADD COLUMN IF NOT EXISTS remaining_quantity DECIMAL;
UPDATE konektag.klots SET remaining_quantity = quantity_k WHERE remaining_quantity IS NULL;
ALTER TABLE konektag.klots ALTER COLUMN remaining_quantity SET DEFAULT 0;
CREATE TABLE IF NOT EXISTS konektag.klot_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  klot_id UUID NOT NULL REFERENCES konektag.klots(id),
  transaction_id UUID REFERENCES konektag.financial_transactions(id),
  allocated_quantity DECIMAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_klot_allocations_klot ON konektag.klot_allocations(klot_id);
CREATE INDEX IF NOT EXISTS idx_klot_allocations_tx ON konektag.klot_allocations(transaction_id);

CREATE TABLE IF NOT EXISTS konektag.refund_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_transaction_id UUID NOT NULL REFERENCES konektag.financial_transactions(id),
  refund_reference VARCHAR(200) NOT NULL UNIQUE,
  refund_amount DECIMAL NOT NULL, currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PENDING_RECONCILIATION')),
  provider_reference VARCHAR(200), reversal_transaction_id UUID REFERENCES konektag.financial_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refund_intents_source ON konektag.refund_intents(source_transaction_id);
CREATE INDEX IF NOT EXISTS idx_refund_intents_ref ON konektag.refund_intents(refund_reference);
CREATE TABLE IF NOT EXISTS konektag.acquisition_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_type VARCHAR(30) NOT NULL CHECK (confirmation_type IN ('stripe_webhook', 'mobile_money_callback', 'mobile_money_manual', 'crypto_confirmation')),
  external_reference VARCHAR(200) NOT NULL UNIQUE, amount DECIMAL NOT NULL, currency VARCHAR(3) NOT NULL,
  rail_proof JSONB, transaction_id UUID REFERENCES konektag.financial_transactions(id),
  status VARCHAR(40) NOT NULL DEFAULT 'RECEIVED', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ
);
ALTER TABLE konektag.acquisition_confirmations ADD COLUMN IF NOT EXISTS operation_id VARCHAR(200);
ALTER TABLE konektag.acquisition_confirmations ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
ALTER TABLE konektag.acquisition_confirmations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE konektag.acquisition_confirmations ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE konektag.acquisition_confirmations ALTER COLUMN status TYPE VARCHAR(40);
UPDATE konektag.acquisition_confirmations
SET status = 'CONFIRMED_PENDING_USER_GL',
    operation_id = COALESCE(operation_id, 'ACQ-' || gen_random_uuid()::text),
    idempotency_key = COALESCE(idempotency_key, 'acquisition:' || external_reference)
WHERE status IN ('RECEIVED', 'VERIFIED');
ALTER TABLE konektag.acquisition_confirmations DROP CONSTRAINT IF EXISTS acquisition_confirmations_status_check;
ALTER TABLE konektag.acquisition_confirmations ADD CONSTRAINT acquisition_confirmations_status_check
  CHECK (status IN ('RECEIVED', 'VERIFIED', 'CONFIRMED_PENDING_USER_GL', 'PROCESSED', 'REJECTED'));
CREATE INDEX IF NOT EXISTS idx_acq_confirmations_ext_ref ON konektag.acquisition_confirmations(external_reference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_confirmations_operation_id
  ON konektag.acquisition_confirmations(operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_confirmations_idempotency_key
  ON konektag.acquisition_confirmations(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Historical finalized rows without deterministic dimensions are deliberately
-- retained. NOT VALID checks all future writes while leaving only those rows
-- for a business decision; a later controlled migration can VALIDATE it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'konektag.financial_transactions'::regclass AND conname = 'ck_finalized_dimensions') THEN
    ALTER TABLE konektag.financial_transactions ADD CONSTRAINT ck_finalized_dimensions CHECK (
      status NOT IN ('completed', 'reversed') OR (
        legal_entity_id IS NOT NULL AND corridor_id IS NOT NULL AND operation_id IS NOT NULL
        AND regulatory_profile_id IS NOT NULL AND currency IS NOT NULL AND value_date IS NOT NULL
        AND eligibility_decision IS NOT NULL
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'konektag.financial_transactions'::regclass AND conname = 'ck_reversal_fields') THEN
    ALTER TABLE konektag.financial_transactions ADD CONSTRAINT ck_reversal_fields CHECK (
      transaction_type <> 'reversal' OR (source_operation_id IS NOT NULL AND reversal_reason IS NOT NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'konektag.financial_transactions'::regclass AND conname = 'fk_financial_tx_source_operation') THEN
    ALTER TABLE konektag.financial_transactions ADD CONSTRAINT fk_financial_tx_source_operation
      FOREIGN KEY (source_operation_id) REFERENCES konektag.financial_transactions(id);
  END IF;
END $$;

-- 043 final canonical integration-operation contract. Never restore the old name.
DO $$
BEGIN
  IF to_regclass('konektag.integration_operations') IS NULL AND to_regclass('konektag.external_operation_journal') IS NOT NULL THEN
    ALTER TABLE konektag.external_operation_journal RENAME TO integration_operations;
  END IF;
  IF to_regclass('konektag.integration_operations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'konektag' AND table_name = 'integration_operations' AND column_name = 'operation_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'konektag' AND table_name = 'integration_operations' AND column_name = 'integration_type') THEN
    ALTER TABLE konektag.integration_operations RENAME COLUMN operation_type TO integration_type;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS konektag.integration_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), integration_type VARCHAR(50) NOT NULL,
  aggregate_type VARCHAR(50) NOT NULL DEFAULT 'Recharge', aggregate_ref VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE, request_fingerprint VARCHAR(64), external_reference VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'prepared', attempt_count INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  outbox_event_id UUID REFERENCES konektag.outbox_events(id), last_error TEXT, metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_io_aggregate ON konektag.integration_operations(aggregate_type, aggregate_ref);
CREATE INDEX IF NOT EXISTS idx_io_status ON konektag.integration_operations(status) WHERE status IN ('prepared', 'reconciliation_required');
CREATE INDEX IF NOT EXISTS idx_io_idempotent ON konektag.integration_operations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_io_created ON konektag.integration_operations(created_at DESC);

-- 083 shared checkout-intents contract.
CREATE TABLE IF NOT EXISTS konektag.checkout_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), token_hash VARCHAR(64) NOT NULL,
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id), amount DECIMAL NOT NULL, currency VARCHAR(3) NOT NULL,
  service_description TEXT, quote_valuation JSONB, regulatory_profile_id UUID REFERENCES konektag.regulatory_profiles(id),
  klot_id UUID REFERENCES konektag.klots(id), allocation_rule JSONB, expiration TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
  operation_id UUID, usage_unique BOOLEAN NOT NULL DEFAULT true, version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), consumed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_token_hash ON konektag.checkout_intents(token_hash);
CREATE INDEX IF NOT EXISTS idx_checkout_merchant ON konektag.checkout_intents(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_checkout_status ON konektag.checkout_intents(status);

COMMIT;
