-- Migration 038 : Lien merchant ↔ établissement ERPNext + paiement QR
-- Idempotent — utilise IF NOT EXISTS.

BEGIN;

-- merchant_profiles : colonnes de provisionnement ERPNext
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS erpnext_establishment_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provisioning_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS provisioning_error TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provisioning_completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_erpnext_estab
  ON konektag.merchant_profiles(erpnext_establishment_id)
  WHERE erpnext_establishment_id IS NOT NULL;

-- financial_transactions : marchand bénéficiaire
ALTER TABLE konektag.financial_transactions
  ADD COLUMN IF NOT EXISTS merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id);

CREATE INDEX IF NOT EXISTS idx_fin_tx_merchant
  ON konektag.financial_transactions(merchant_profile_id)
  WHERE merchant_profile_id IS NOT NULL;

COMMIT;
