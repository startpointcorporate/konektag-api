-- Migration 062 : Certification commerçant + colonnes crawler manquantes
-- Idempotent — utilise IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

BEGIN;

-- ═══ 1. certification_status sur merchant_profiles ═══
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS certification_status VARCHAR(20) NOT NULL DEFAULT 'NON_CERTIFIED';

ALTER TABLE konektag.merchant_profiles DROP CONSTRAINT IF EXISTS merchant_profiles_certification_status_check;
ALTER TABLE konektag.merchant_profiles ADD CONSTRAINT merchant_profiles_certification_status_check
  CHECK (certification_status IN ('NON_CERTIFIED', 'PENDING_VALIDATION', 'VALIDATED'));

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_certification
  ON konektag.merchant_profiles(certification_status);

-- Les commerces déjà publiés avec KYC utilisateur validé passent en NON_CERTIFIED par défaut
-- (le nouveau processus de certification doit être suivi).
-- Si un badge « certifié » existait avant cette migration, il est révoqué (NON_CERTIFIED = défaut).

-- ═══ 2. Table certification documents ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_certification_documents (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id     UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    document_type           VARCHAR(30) NOT NULL
                            CHECK (document_type IN ('business_document', 'manager_identity', 'establishment_photo')),
    title                   VARCHAR(200),
    file_url                VARCHAR(500) NOT NULL,
    file_key                VARCHAR(500),
    mime_type               VARCHAR(100),
    submitted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cert_docs_profile
  ON konektag.merchant_certification_documents(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_cert_docs_type
  ON konektag.merchant_certification_documents(merchant_profile_id, document_type);

-- ═══ 3. Dossier de certification (état de la soumission) ═══
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS certification_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS certification_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS certification_reviewed_by UUID REFERENCES konektag.users(id);

-- ═══ 4. Colonnes crawler manquantes (utilisées par le crawler mais absentes des migrations) ═══
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS rating            DECIMAL(3,1),
  ADD COLUMN IF NOT EXISTS photo_urls        JSONB,
  ADD COLUMN IF NOT EXISTS has_delivery      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_takeout       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_dine_in       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS neighborhood      VARCHAR(200),
  ADD COLUMN IF NOT EXISTS opening_hours_json JSONB,
  ADD COLUMN IF NOT EXISTS price_range       VARCHAR(10);

-- ═══ 5. Fonction SQL : compter les transactions réussies reçues par un commerce ═══
CREATE OR REPLACE FUNCTION konektag.count_merchant_received_transactions(p_merchant_profile_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)::integer INTO v_count
    FROM konektag.financial_transactions ft
    WHERE ft.merchant_profile_id = p_merchant_profile_id
      AND ft.status = 'completed'
      AND ft.transaction_type IN ('qr_payment', 'api_payment');
    RETURN v_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- ═══ 6. Index sur financial_transactions pour le comptage par marchand ═══
CREATE INDEX IF NOT EXISTS idx_fin_tx_merchant_count
  ON konektag.financial_transactions(merchant_profile_id, status)
  WHERE merchant_profile_id IS NOT NULL AND status = 'completed';

COMMIT;
