-- Migration 064 : Fondations reglementaires V8/V3
-- Agregats versions : LegalEntity, CounterpartyEntity, RegulatoryProfile,
-- B2BSettlementProfile, RegulatedActor, ComplianceCase, KLot, ValuationRecord
-- Idempotent : toutes les instructions utilisent IF NOT EXISTS / IF EXISTS

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. LEGAL_ENTITIES — entites legales versionnees (KTG-FR, KTG-CG)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.legal_entities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(20) NOT NULL UNIQUE,
    legal_name          VARCHAR(200) NOT NULL,
    country_code        VARCHAR(5) NOT NULL,
    base_currency       VARCHAR(10) NOT NULL,
    frappe_company      VARCHAR(200),
    regulatory_identifier VARCHAR(100),
    tax_id              VARCHAR(100),
    status              VARCHAR(20) NOT NULL DEFAULT 'NOT_CONFIGURED'
                            CHECK (status IN ('NOT_CONFIGURED', 'PENDING_APPROVAL', 'APPROVED', 'SUSPENDED', 'REVOKED')),
    approved_by         UUID,
    approved_at         TIMESTAMPTZ,
    valid_from          DATE,
    valid_until         DATE,
    version             INTEGER NOT NULL DEFAULT 1,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_legal_entities_code ON konektag.legal_entities(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_legal_entities_country ON konektag.legal_entities(country_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_legal_entities_status ON konektag.legal_entities(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. COUNTERPARTY_ENTITIES — contreparties : PSP, banque, Mobile Money
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.counterparty_entities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(50) NOT NULL UNIQUE,
    legal_name          VARCHAR(200) NOT NULL,
    entity_type         VARCHAR(30) NOT NULL
                            CHECK (entity_type IN ('psp', 'bank', 'mobile_money', 'crypto', 'emisor', 'other')),
    country_code        VARCHAR(5),
    license_identifier  VARCHAR(100),
    contract_ref        VARCHAR(200),
    contract_signed_at  DATE,
    status              VARCHAR(20) NOT NULL DEFAULT 'NOT_CONFIGURED'
                            CHECK (status IN ('NOT_CONFIGURED', 'PENDING_ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
    version             INTEGER NOT NULL DEFAULT 1,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_counterparty_code ON konektag.counterparty_entities(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_counterparty_type ON konektag.counterparty_entities(entity_type) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 3. REGULATED_ACTORS — acteurs habilites (PSP specifique, EME, banque)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.regulated_actors (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_code          VARCHAR(50) NOT NULL UNIQUE,
    actor_name          VARCHAR(200) NOT NULL,
    actor_type          VARCHAR(30) NOT NULL
                            CHECK (actor_type IN ('psp', 'eme', 'bank', 'mobile_money_operator', 'crypto_exchange', 'internal')),
    counterparty_id     UUID REFERENCES konektag.counterparty_entities(id),
    jurisdiction        VARCHAR(5),
    license_ref         VARCHAR(200),
    license_valid_from  DATE,
    license_valid_until DATE,
    status              VARCHAR(20) NOT NULL DEFAULT 'NOT_CONFIGURED'
                            CHECK (status IN ('NOT_CONFIGURED', 'PENDING_APPROVAL', 'APPROVED', 'SUSPENDED', 'REVOKED')),
    approved_by         UUID,
    approved_at         TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_regulated_actors_code ON konektag.regulated_actors(actor_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_regulated_actors_type ON konektag.regulated_actors(actor_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_regulated_actors_counterparty ON konektag.regulated_actors(counterparty_id) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 4. REGULATORY_PROFILES — profils reglementaires versions par corridor
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.regulatory_profiles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_code            VARCHAR(50) NOT NULL UNIQUE,
    profile_name            VARCHAR(200) NOT NULL,
    legal_entity_id         UUID NOT NULL REFERENCES konektag.legal_entities(id),
    country_of_origin       VARCHAR(5) NOT NULL,
    country_of_destination  VARCHAR(5) NOT NULL,
    corridor_id             VARCHAR(30) NOT NULL,
    authorized_operation    VARCHAR(30) NOT NULL
                                CHECK (authorized_operation IN (
                                    'acquisition', 'gift', 'qr_payment', 'link_payment',
                                    'consumption', 'settlement', 'clearing', 'refund', 'reversal'
                                )),
    fund_holder             VARCHAR(50) NOT NULL
                                CHECK (fund_holder IN ('konektag_user', 'konektag_france', 'konektag_congo', 'regulated_actor')),
    regulated_actor_id      UUID REFERENCES konektag.regulated_actors(id),
    rail                    VARCHAR(30) NOT NULL
                CHECK (rail IN (
                    'stripe', 'mtn_money', 'orange_money', 'airtel_money', 'mobile_money',
                    'bank_transfer', 'crypto', 'internal', 'manual'
                )),
    execution_mode          VARCHAR(25) NOT NULL DEFAULT 'provider_confirmation'
                                CHECK (execution_mode IN ('provider_confirmation', 'manual_double_approval', 'reconciliation')),
    min_kyc_level           VARCHAR(20) NOT NULL DEFAULT 'basic'
                                CHECK (min_kyc_level IN ('none', 'basic', 'standard', 'enhanced')),
    max_amount_per_tx       NUMERIC(20,2),
    max_amount_daily        NUMERIC(20,2),
    max_amount_monthly      NUMERIC(20,2),
    max_gift_depth          INTEGER DEFAULT 2,
    netting_allowed         BOOLEAN NOT NULL DEFAULT false,
    evidence_required       JSONB DEFAULT '[]',
    status                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXPIRED', 'SUSPENDED', 'REVOKED')),
    approved_by             UUID,
    approved_at             TIMESTAMPTZ,
    valid_from              DATE NOT NULL,
    valid_until             DATE,
    version                 INTEGER NOT NULL DEFAULT 1,
    metadata                JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reg_profiles_code ON konektag.regulatory_profiles(profile_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reg_profiles_entity ON konektag.regulatory_profiles(legal_entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reg_profiles_corridor ON konektag.regulatory_profiles(country_of_origin, country_of_destination) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reg_profiles_status ON konektag.regulatory_profiles(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reg_profiles_operation ON konektag.regulatory_profiles(authorized_operation) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 5. B2B_SETTLEMENT_PROFILES — convention inter-societes
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.b2b_settlement_profiles (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_code            VARCHAR(50) NOT NULL UNIQUE,
    legal_entity_a_id       UUID NOT NULL REFERENCES konektag.legal_entities(id),
    legal_entity_b_id       UUID NOT NULL REFERENCES konektag.legal_entities(id),
    netting_allowed         BOOLEAN NOT NULL DEFAULT false,
    settlement_currency     VARCHAR(10) NOT NULL,
    fx_source               VARCHAR(30) NOT NULL DEFAULT 'manual'
                                CHECK (fx_source IN ('manual', 'central_bank', 'provider_quote')),
    fx_spread_bps           INTEGER DEFAULT 0,
    min_settlement_amount   NUMERIC(20,2),
    settlement_frequency    VARCHAR(20) NOT NULL DEFAULT 'monthly'
                                CHECK (settlement_frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'on_demand')),
    required_approvals      JSONB DEFAULT '["finance_a", "finance_b", "compliance"]',
    status                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXPIRED', 'SUSPENDED')),
    approved_by             UUID,
    approved_at             TIMESTAMPTZ,
    valid_from              DATE NOT NULL,
    valid_until             DATE,
    version                 INTEGER NOT NULL DEFAULT 1,
    metadata                JSONB DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ,
    CONSTRAINT uq_b2b_entity_pair UNIQUE (legal_entity_a_id, legal_entity_b_id)
);

CREATE INDEX IF NOT EXISTS idx_b2b_profiles_code ON konektag.b2b_settlement_profiles(profile_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_b2b_profiles_status ON konektag.b2b_settlement_profiles(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 6. COMPLIANCE_CASES — dossiers conformite versionnes
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.compliance_cases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_ref            VARCHAR(50) NOT NULL UNIQUE,
    case_type           VARCHAR(30) NOT NULL
                            CHECK (case_type IN ('sanction_hit', 'pep_match', 'ubo_alert', 'country_risk', 'kyc_exception', 'kyb_exception', 'fraud_alert', 'other')),
    severity            VARCHAR(10) NOT NULL DEFAULT 'medium'
                            CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    subject_party_id    UUID REFERENCES konektag.parties(id),
    subject_user_id     UUID,
    legal_entity_id     UUID REFERENCES konektag.legal_entities(id),
    triggered_by        VARCHAR(50) NOT NULL,
    triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED_APPROVED', 'RESOLVED_BLOCKED', 'CLOSED')),
    resolution          TEXT,
    resolved_by         UUID,
    resolved_at         TIMESTAMPTZ,
    final_decision      VARCHAR(30),
    version             INTEGER NOT NULL DEFAULT 1,
    evidence            JSONB DEFAULT '[]',
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_ref ON konektag.compliance_cases(case_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_case_party ON konektag.compliance_cases(subject_party_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_case_status ON konektag.compliance_cases(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_case_entity ON konektag.compliance_cases(legal_entity_id) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 7. KLOTS — lots K versionnes
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.klots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    klot_ref            VARCHAR(100) NOT NULL UNIQUE,
    origin_entity_id    UUID NOT NULL REFERENCES konektag.legal_entities(id),
    origin_country      VARCHAR(5) NOT NULL,
    rail                VARCHAR(30) NOT NULL,
    rail_ref            VARCHAR(200),
    issuer              VARCHAR(100),
    quantity_k          INTEGER NOT NULL CHECK (quantity_k > 0),
    economic_currency   VARCHAR(10) NOT NULL,
    economic_value      NUMERIC(20,2) NOT NULL,
    regulatory_profile_id UUID REFERENCES konektag.regulatory_profiles(id),
    restrictions        JSONB DEFAULT '{}',
    status              VARCHAR(20) NOT NULL DEFAULT 'CREATED'
                            CHECK (status IN ('CREATED', 'VALUATED', 'AVAILABLE', 'PARTIALLY_CONSUMED', 'EXHAUSTED', 'FROZEN')),
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_klots_ref ON konektag.klots(klot_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_klots_origin_entity ON konektag.klots(origin_entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_klots_status ON konektag.klots(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 8. VALUATION_RECORDS — enregistrements de valorisation par KLot
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.valuation_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    klot_id             UUID NOT NULL REFERENCES konektag.klots(id),
    source_currency     VARCHAR(10) NOT NULL,
    target_currency     VARCHAR(10) NOT NULL,
    rate                NUMERIC(20,8) NOT NULL,
    spread_bps          INTEGER DEFAULT 0,
    rate_source         VARCHAR(50) NOT NULL,
    rate_timestamp      TIMESTAMPTZ NOT NULL,
    fx_risk_holder      VARCHAR(50) NOT NULL DEFAULT 'konektag_user'
                            CHECK (fx_risk_holder IN ('konektag_user', 'konektag_france', 'konektag_congo')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_valuation_klot ON konektag.valuation_records(klot_id);

-- ═══════════════════════════════════════════════════════════════
-- 9. MERCHANT_SALES — ventes locales commerçant
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.merchant_sales (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_ref            VARCHAR(100) NOT NULL UNIQUE,
    merchant_profile_id UUID NOT NULL,
    legal_entity_id     UUID NOT NULL REFERENCES konektag.legal_entities(id),
    transaction_id      UUID REFERENCES konektag.financial_transactions(id),
    klot_id             UUID REFERENCES konektag.klots(id),
    gross_amount        NUMERIC(20,2) NOT NULL,
    net_amount          NUMERIC(20,2) NOT NULL,
    tax_amount          NUMERIC(20,2) DEFAULT 0,
    commission_amount   NUMERIC(20,2) DEFAULT 0,
    currency            VARCHAR(10) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'CREATED'
                            CHECK (status IN ('CREATED', 'SETTLED', 'PARTIALLY_SETTLED', 'CANCELLED')),
    settlement_due_date DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_merchant_sales_ref ON konektag.merchant_sales(sale_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_merchant_sales_entity ON konektag.merchant_sales(legal_entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_merchant_sales_merchant ON konektag.merchant_sales(merchant_profile_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_merchant_sales_status ON konektag.merchant_sales(status) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 10. INTERCOMPANY_POSITIONS — positions inter-societes
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.intercompany_positions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_ref        VARCHAR(100) NOT NULL UNIQUE,
    legal_entity_a_id   UUID NOT NULL REFERENCES konektag.legal_entities(id),
    legal_entity_b_id   UUID NOT NULL REFERENCES konektag.legal_entities(id),
    b2b_profile_id      UUID REFERENCES konektag.b2b_settlement_profiles(id),
    source_sale_id      UUID REFERENCES konektag.merchant_sales(id),
    source_klot_id      UUID REFERENCES konektag.klots(id),
    amount              NUMERIC(20,2) NOT NULL,
    currency            VARCHAR(10) NOT NULL,
    direction           VARCHAR(10) NOT NULL CHECK (direction IN ('A_TO_B', 'B_TO_A')),
    value_date          DATE NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'INCLUDED_IN_BATCH', 'SETTLED', 'CANCELLED')),
    clearing_batch_id   UUID,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_interco_positions_ref ON konektag.intercompany_positions(position_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_interco_positions_pair ON konektag.intercompany_positions(legal_entity_a_id, legal_entity_b_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_interco_positions_status ON konektag.intercompany_positions(status) WHERE deleted_at IS NULL;

COMMIT;
