-- Migration 034 : Consentement marketing et référence Mautic
-- Ajoute les colonnes nécessaires à la synchronisation Mautic

BEGIN;

ALTER TABLE konektag.users
  ADD COLUMN IF NOT EXISTS marketing_opt_in        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_source VARCHAR(100),
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mautic_contact_id       BIGINT;

COMMENT ON COLUMN konektag.users.marketing_opt_in IS 'Consentement explicite pour les communications marketing';
COMMENT ON COLUMN konektag.users.marketing_opt_in_at IS 'Date du consentement';
COMMENT ON COLUMN konektag.users.marketing_opt_in_source IS 'Origine du consentement (registration, profile, onboarding)';
COMMENT ON COLUMN konektag.users.marketing_opt_out_at IS 'Date du retrait de consentement';
COMMENT ON COLUMN konektag.users.mautic_contact_id IS 'Identifiant du Contact Mautic associé';

COMMIT;
