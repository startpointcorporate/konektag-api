-- Migration 066 : Surcharges reglementaires par utilisateur
-- Permet de configurer des plafonds individuels depuis l'ERP/backoffice
-- Sans modifier le profil reglementaire de base

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.user_regulatory_overrides (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES konektag.users(id),
    operation           VARCHAR(30) NOT NULL,
    corridor_id         VARCHAR(30) NOT NULL,
    max_amount_per_tx   NUMERIC(20,2),
    max_amount_daily    NUMERIC(20,2),
    max_amount_monthly  NUMERIC(20,2),
    is_active           BOOLEAN NOT NULL DEFAULT true,
    set_by              UUID,
    set_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason              TEXT,
    valid_until         DATE,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT uq_user_override UNIQUE (user_id, operation, corridor_id)
);

CREATE INDEX IF NOT EXISTS idx_user_overrides_active ON konektag.user_regulatory_overrides(user_id) WHERE is_active = true AND deleted_at IS NULL;

COMMIT;
