-- Migration 035 : Mautic Companies — référence société et date de sync

BEGIN;

ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS mautic_company_id BIGINT,
  ADD COLUMN IF NOT EXISTS mautic_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN konektag.merchant_profiles.mautic_company_id IS 'Identifiant Mautic de la Company associée';
COMMENT ON COLUMN konektag.merchant_profiles.mautic_synced_at IS 'Dernière synchronisation Mautic';

COMMIT;
