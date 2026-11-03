-- Migration 078 : P18 — retention des donnees
-- Idempotent

BEGIN;

ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS data_retention_days INTEGER DEFAULT 730;
ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ;
ALTER TABLE konektag.disputes ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ;

-- Marquer les donnees KYC a purger 2 ans apres creation
UPDATE konektag.kyc_orders SET purge_at = created_at + interval '2 years' WHERE purge_at IS NULL AND created_at < now() - interval '2 years';
UPDATE konektag.disputes SET purge_at = created_at + interval '5 years' WHERE purge_at IS NULL;

COMMIT;
