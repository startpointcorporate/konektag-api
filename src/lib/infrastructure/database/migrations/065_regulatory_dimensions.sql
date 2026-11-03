-- Migration 065 : Dimensions reglementaires V3 sur transactions et ecritures
-- Ajoute LegalEntityId, CounterpartyEntityId, CorridorId, OperationId,
-- SourceOperationId, PositionId, KLotId, RegulatoryProfileId,
-- RegulatedActorId, RegulatedExecutionRef, currency_value_date
-- Idempotent : ALTER TABLE ADD COLUMN IF NOT EXISTS

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Ajouter les dimensions V3 a financial_transactions
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    ALTER TABLE konektag.financial_transactions
        ADD COLUMN IF NOT EXISTS legal_entity_id          UUID REFERENCES konektag.legal_entities(id),
        ADD COLUMN IF NOT EXISTS counterparty_entity_id   UUID REFERENCES konektag.counterparty_entities(id),
        ADD COLUMN IF NOT EXISTS corridor_id              VARCHAR(30),
        ADD COLUMN IF NOT EXISTS operation_id             VARCHAR(100),
        ADD COLUMN IF NOT EXISTS source_operation_id      UUID REFERENCES konektag.financial_transactions(id),
        ADD COLUMN IF NOT EXISTS position_id              UUID,
        ADD COLUMN IF NOT EXISTS klot_id                  UUID REFERENCES konektag.klots(id),
        ADD COLUMN IF NOT EXISTS regulatory_profile_id    UUID REFERENCES konektag.regulatory_profiles(id),
        ADD COLUMN IF NOT EXISTS regulated_actor_id       UUID REFERENCES konektag.regulated_actors(id),
        ADD COLUMN IF NOT EXISTS regulated_execution_ref  VARCHAR(200),
        ADD COLUMN IF NOT EXISTS value_date               DATE,
        ADD COLUMN IF NOT EXISTS eligibility_decision     VARCHAR(30),
        ADD COLUMN IF NOT EXISTS eligibility_reason       TEXT,
        ADD COLUMN IF NOT EXISTS source_currency          VARCHAR(10),
        ADD COLUMN IF NOT EXISTS target_currency          VARCHAR(10),
        ADD COLUMN IF NOT EXISTS fx_rate                  NUMERIC(20,8),
        ADD COLUMN IF NOT EXISTS fx_spread_bps            INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fx_risk_holder           VARCHAR(50);
END $$;

-- Indexes pour les nouvelles dimensions
CREATE INDEX IF NOT EXISTS idx_fin_tx_legal_entity ON konektag.financial_transactions(legal_entity_id) WHERE legal_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_corridor ON konektag.financial_transactions(corridor_id) WHERE corridor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_operation_id ON konektag.financial_transactions(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_klot ON konektag.financial_transactions(klot_id) WHERE klot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_reg_profile ON konektag.financial_transactions(regulatory_profile_id) WHERE regulatory_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_reg_actor ON konektag.financial_transactions(regulated_actor_id) WHERE regulated_actor_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. Ajouter les dimensions V3 a ledger_entries
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    ALTER TABLE konektag.ledger_entries
        ADD COLUMN IF NOT EXISTS legal_entity_id          UUID REFERENCES konektag.legal_entities(id),
        ADD COLUMN IF NOT EXISTS counterparty_entity_id   UUID REFERENCES konektag.counterparty_entities(id),
        ADD COLUMN IF NOT EXISTS corridor_id              VARCHAR(30),
        ADD COLUMN IF NOT EXISTS operation_id             VARCHAR(100),
        ADD COLUMN IF NOT EXISTS source_operation_id      UUID REFERENCES konektag.financial_transactions(id),
        ADD COLUMN IF NOT EXISTS position_id              UUID,
        ADD COLUMN IF NOT EXISTS klot_id                  UUID REFERENCES konektag.klots(id),
        ADD COLUMN IF NOT EXISTS regulatory_profile_id    UUID REFERENCES konektag.regulatory_profiles(id),
        ADD COLUMN IF NOT EXISTS regulated_actor_id       UUID REFERENCES konektag.regulated_actors(id),
        ADD COLUMN IF NOT EXISTS regulated_execution_ref  VARCHAR(200),
        ADD COLUMN IF NOT EXISTS value_date               DATE,
        ADD COLUMN IF NOT EXISTS source_currency          VARCHAR(10),
        ADD COLUMN IF NOT EXISTS target_currency          VARCHAR(10),
        ADD COLUMN IF NOT EXISTS fx_rate                  NUMERIC(20,8);
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_legal_entity ON konektag.ledger_entries(legal_entity_id) WHERE legal_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_klot ON konektag.ledger_entries(klot_id) WHERE klot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_operation ON konektag.ledger_entries(operation_id) WHERE operation_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- 3. Contrainte d'unicite sur operation_id (une operation = une transaction)
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_financial_tx_operation_id'
    ) THEN
        CREATE UNIQUE INDEX uq_financial_tx_operation_id ON konektag.financial_transactions(operation_id)
            WHERE operation_id IS NOT NULL;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 4. Ajouter le champ version pour optimistic locking sur les tables existantes
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE konektag.ledger_entries ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

COMMIT;
