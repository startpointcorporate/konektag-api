-- Migration 076 : P01 — LegalCountry, consentements versionnes, reevaluation KYC
-- Idempotent

BEGIN;

-- LegalCountry : pays de residence obligatoire pour le profil reglementaire
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS legal_country VARCHAR(5);
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS cgu_accepted_version VARCHAR(20);
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS cgu_accepted_at TIMESTAMPTZ;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS privacy_accepted_version VARCHAR(20);
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS kyc_last_evaluated_at TIMESTAMPTZ;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS kyc_expires_at DATE;

-- Index pour reevaluation periodique
CREATE INDEX IF NOT EXISTS idx_users_kyc_expires ON konektag.users(kyc_expires_at) WHERE kyc_expires_at IS NOT NULL AND deleted_at IS NULL;

COMMIT;
