-- Migration 071 : Gate activation marchand + statut KYB
-- Ajoute les champs requis pour l'activation V3 d'un marchand
-- avant toute creation QR/Link/API key/publication
-- Idempotent

BEGIN;

-- Etat KYB marchand
ALTER TABLE konektag.merchant_profiles
    ADD COLUMN IF NOT EXISTS kyb_status VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED'
        CHECK (kyb_status IN (
            'NOT_STARTED', 'DOCUMENTS_SUBMITTED', 'UBO_VERIFIED',
            'SANCTIONS_SCREENED', 'CONTRACT_SIGNED', 'ACCOUNT_VERIFIED',
            'RISK_ASSESSED', 'MERCHANT_APPROVED', 'REJECTED', 'SUSPENDED'
        )),
    ADD COLUMN IF NOT EXISTS kyb_contract_ref VARCHAR(200),
    ADD COLUMN IF NOT EXISTS kyb_contract_signed_at DATE,
    ADD COLUMN IF NOT EXISTS kyb_settlement_account VARCHAR(100),
    ADD COLUMN IF NOT EXISTS kyb_settlement_rail VARCHAR(30),
    ADD COLUMN IF NOT EXISTS kyb_risk_category VARCHAR(20)
        CHECK (kyb_risk_category IS NULL OR kyb_risk_category IN ('low', 'medium', 'high')),
    ADD COLUMN IF NOT EXISTS kyb_review_date DATE,
    ADD COLUMN IF NOT EXISTS kyb_approved_by UUID,
    ADD COLUMN IF NOT EXISTS kyb_approved_at TIMESTAMPTZ;

-- Index
CREATE INDEX IF NOT EXISTS idx_merchant_kyb_status ON konektag.merchant_profiles(kyb_status) WHERE deleted_at IS NULL;

-- Ajouter numero de telephone + reseau du marchand pour le reglement mobile money
ALTER TABLE konektag.merchant_profiles
    ADD COLUMN IF NOT EXISTS settlement_phone VARCHAR(30),
    ADD COLUMN IF NOT EXISTS settlement_network VARCHAR(30);

-- Migration des wallets commercants existants : ne plus crediter 1100
-- Remplacer par un compte de dette locale (2000) quand le marchand est active
-- Les soldes 1100 existants sont preserves en lecture seule jusqu'a migration complete

COMMIT;
