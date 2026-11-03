-- Migration 063 : Revue KYC manuelle backoffice
-- Ajoute KYC_PENDING_REVIEW et pending_review

BEGIN;

-- Ajouter KYC_PENDING_REVIEW au CHECK constraint de users.state
ALTER TABLE konektag.users DROP CONSTRAINT IF EXISTS users_state_check;
ALTER TABLE konektag.users ADD CONSTRAINT users_state_check
  CHECK (state IN (
    'DRAFT','ACCOUNT_CREATED','OTP_VERIFIED',
    'KYC_PENDING','KYC_PROCESSING','KYC_PENDING_REVIEW','KYC_VALIDATED',
    'KYC_REJECTED','KYC_SKIPPED','FEATURES_SELECTED','COMPLETED'
  ));

-- Ajouter pending_review au CHECK constraint de kyc_orders.status
ALTER TABLE konektag.kyc_orders DROP CONSTRAINT IF EXISTS kyc_orders_status_check;
ALTER TABLE konektag.kyc_orders ADD CONSTRAINT kyc_orders_status_check
  CHECK (status IN ('pending','quarantined','scanning','processing','pending_review','verified','rejected'));

-- Index pour lister les KYC en attente de revue admin
CREATE INDEX IF NOT EXISTS idx_kyc_orders_pending_review
  ON konektag.kyc_orders(status, created_at DESC)
  WHERE status = 'pending_review';

COMMIT;
