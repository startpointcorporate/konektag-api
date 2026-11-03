-- Migration 072 : Mappings comptables KTG-FR / KTG-CG
-- Remplace les destinations codées en dur vers 2MBI / Business Unit
-- Les comptes interco restent generiques et sont dimensionnes par CounterpartyEntity

BEGIN;

-- Table mapping compagnie -> comptes specifiques PCG/SYSCOHADA
CREATE TABLE IF NOT EXISTS konektag.accounting_mappings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_entity_id     UUID NOT NULL REFERENCES konektag.legal_entities(id),
    account_code        VARCHAR(20) NOT NULL,
    erp_account_code    VARCHAR(20) NOT NULL,
    erp_cost_center     VARCHAR(200),
    erp_account_name    VARCHAR(200),
    is_interco          BOOLEAN NOT NULL DEFAULT false,
    valid_from          DATE NOT NULL,
    valid_until         DATE,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT uq_entity_account UNIQUE (legal_entity_id, account_code, erp_account_code)
);

CREATE INDEX IF NOT EXISTS idx_acct_mapping_entity ON konektag.accounting_mappings(legal_entity_id) WHERE deleted_at IS NULL;

COMMIT;
