-- Migration 084 : Merchant KYB, settlements, disputes
-- Comprehensive merchant activation checks, settlement lifecycle, dispute state machine.

BEGIN;

-- 1. Merchant settlement table
CREATE TABLE IF NOT EXISTS konektag.merchant_settlements (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_ref          VARCHAR(100) NOT NULL UNIQUE,
    merchant_profile_id     UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
    legal_entity_id         UUID NOT NULL REFERENCES konektag.legal_entities(id),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    gross_amount            DECIMAL NOT NULL DEFAULT 0,
    net_amount              DECIMAL NOT NULL DEFAULT 0,
    tax_amount              DECIMAL NOT NULL DEFAULT 0,
    commission_amount       DECIMAL NOT NULL DEFAULT 0,
    currency                VARCHAR(3) NOT NULL,
    status                  VARCHAR(30) NOT NULL DEFAULT 'PREPARED'
                                CHECK (status IN ('PREPARED', 'APPROVED', 'BANK_PENDING', 'SETTLED', 'REJECTED')),
    prepared_by             UUID NOT NULL,
    approved_by             UUID,
    confirmed_by            UUID,
    evidence_required       JSONB DEFAULT '[]',
    evidence_provided       JSONB DEFAULT '[]',
    bank_proof_url          TEXT,
    settlement_date         DATE,
    notes                   TEXT,
    version                 INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merchant_settlements_merchant ON konektag.merchant_settlements(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_merchant_settlements_status ON konektag.merchant_settlements(status);

-- 2. Settlement-sales link table
CREATE TABLE IF NOT EXISTS konektag.merchant_settlement_sales (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_id       UUID NOT NULL REFERENCES konektag.merchant_settlements(id),
    sale_id             UUID NOT NULL REFERENCES konektag.merchant_sales(id),
    UNIQUE(sale_id)
);
CREATE INDEX IF NOT EXISTS idx_settlement_sales_settlement ON konektag.merchant_settlement_sales(settlement_id);

-- 3. Settlement evidence table
CREATE TABLE IF NOT EXISTS konektag.settlement_evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_id   UUID NOT NULL REFERENCES konektag.merchant_settlements(id),
    evidence_type   VARCHAR(30) NOT NULL CHECK (evidence_type IN ('bank_statement', 'bank_transfer', 'psp_confirm', 'cobac_declaration', 'other')),
    evidence_url    TEXT NOT NULL,
    content_hash    VARCHAR(64),
    verified        BOOLEAN NOT NULL DEFAULT false,
    verified_by     UUID,
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Admin approval records
CREATE TABLE IF NOT EXISTS konektag.admin_approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     VARCHAR(50) NOT NULL,
    entity_id       UUID NOT NULL,
    approver_id     UUID NOT NULL,
    approval_role   VARCHAR(50) NOT NULL CHECK (approval_role IN ('compliance', 'finance_local', 'finance_groupe', 'approver', 'admin_technique', 'operations', 'support')),
    decision        VARCHAR(20) NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
    comment         TEXT,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(entity_type, entity_id, approver_id, approval_role)
);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_entity ON konektag.admin_approvals(entity_type, entity_id);

COMMIT;
