-- The existing BANK_PSP provider is represented by the established CARD
-- payment method. Do not alter provider constraints or historical accounts.
BEGIN;

CREATE TABLE IF NOT EXISTS konektag.merchant_settlement_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID NOT NULL UNIQUE REFERENCES konektag.merchant_settlements(id),
  provider_account_id UUID NOT NULL REFERENCES konektag.merchant_payment_provider_accounts(id),
  rail VARCHAR(32) NOT NULL CHECK (rail IN ('BANK', 'PSP', 'MOBILE_MONEY')),
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  provider_payout_id VARCHAR(255) UNIQUE,
  operator_reference VARCHAR(255),
  -- This legacy-compatible status is deliberately not used for the Manual ERP
  -- workflow. Migration 110 adds manual_workflow_status without rewriting rows.
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED')),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  evidence_url TEXT,
  evidence_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_merchant_settlement_payouts_provider
  ON konektag.merchant_settlement_payouts(provider_account_id, provider_payout_id);

COMMIT;
