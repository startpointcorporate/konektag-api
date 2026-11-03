-- P01 corrective migration: immutable evidence for versioned legal consent.
BEGIN;

ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS erpnext_contact_id VARCHAR(140);

CREATE TABLE IF NOT EXISTS konektag.legal_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES konektag.users(id),
    erpnext_contact_id VARCHAR(140),
    accepted BOOLEAN NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    legal_country VARCHAR(5) NOT NULL,
    terms_document_id VARCHAR(140) NOT NULL,
    terms_version VARCHAR(100) NOT NULL,
    terms_hash VARCHAR(64) NOT NULL,
    terms_content_snapshot TEXT,
    terms_url TEXT,
    privacy_document_id VARCHAR(140) NOT NULL,
    privacy_version VARCHAR(100) NOT NULL,
    privacy_hash VARCHAR(64) NOT NULL,
    privacy_content_snapshot TEXT,
    privacy_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_legal_consents_user ON konektag.legal_consents(user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_consents_erp_contact ON konektag.legal_consents(erpnext_contact_id) WHERE erpnext_contact_id IS NOT NULL;

ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS erpnext_contact_id VARCHAR(140);
ALTER TABLE konektag.screening_entries ADD COLUMN IF NOT EXISTS erpnext_contact_id VARCHAR(140);
COMMIT;
