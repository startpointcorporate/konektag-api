-- Migration 079 : Migration runner securise + tables additive pour remplacer DROP CASCADE
-- Cette migration remplace les DROP CASCADE de 073/074 par des operations preservant les donnees.
-- Elle cree aussi la table d'historique des migrations pour le nouveau runner.

BEGIN;

-- Table d'historique des migrations pour le runner versionne
CREATE TABLE IF NOT EXISTS konektag.schema_migrations (
    version       VARCHAR(20) PRIMARY KEY,
    filename      VARCHAR(200) NOT NULL,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum      VARCHAR(64)
);

-- Recreer clearing_batches si elle a ete detruite par un redemarrage avant cette migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'konektag' AND table_name = 'clearing_batches') THEN
    CREATE TABLE konektag.clearing_batches (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_ref               VARCHAR(100) NOT NULL UNIQUE,
        legal_entity_id         UUID NOT NULL REFERENCES konektag.legal_entities(id),
        period_start            DATE NOT NULL,
        period_end              DATE NOT NULL,
        position_count          INTEGER NOT NULL DEFAULT 0,
        net_amount              NUMERIC(20,2),
        currency                VARCHAR(10),
        status                  VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                                    CHECK (status IN ('OPEN', 'FROZEN', 'APPROVED', 'SETTLED', 'REJECTED', 'CANCELLED')),
        initiated_by            UUID,
        finance_a_approved_by   UUID,
        finance_a_approved_at   TIMESTAMPTZ,
        finance_b_approved_by   UUID,
        finance_b_approved_at   TIMESTAMPTZ,
        compliance_approved_by  UUID,
        compliance_approved_at  TIMESTAMPTZ,
        bank_proof_url          TEXT,
        settled_by              UUID,
        settlement_date         DATE,
        version                 INTEGER NOT NULL DEFAULT 1,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at              TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_clearing_batch_ref ON konektag.clearing_batches(batch_ref) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_clearing_batch_status ON konektag.clearing_batches(status) WHERE deleted_at IS NULL;
  END IF;
END $$;

-- Recreer accounting_entry_guides si elle a ete detruite par un redemarrage avant cette migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'konektag' AND table_name = 'accounting_entry_guides') THEN
    CREATE TABLE konektag.accounting_entry_guides (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        legal_entity_id     UUID NOT NULL REFERENCES konektag.legal_entities(id),
        event_type          VARCHAR(30) NOT NULL,
        debit_account       VARCHAR(50) NOT NULL,
        credit_account      VARCHAR(50) NOT NULL,
        description         VARCHAR(200),
        is_active           BOOLEAN NOT NULL DEFAULT true,
        valid_from          DATE NOT NULL DEFAULT CURRENT_DATE,
        valid_until         DATE,
        version             INTEGER NOT NULL DEFAULT 1,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at          TIMESTAMPTZ,
        CONSTRAINT uq_entry_guide_079 UNIQUE (legal_entity_id, event_type)
    );
    CREATE INDEX IF NOT EXISTS idx_entry_guides_entity_079 ON konektag.accounting_entry_guides(legal_entity_id) WHERE deleted_at IS NULL;

    -- Re-seed the entry guides (idempotent, ON CONFLICT DO NOTHING)
    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'acquisition', '512000', '467100', 'Recharge K — Banque → Utilisateurs'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'gift', '467100', '467100', 'Cadeau K — Utilisateur A → Utilisateur B'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'qr_payment', '467100', '401000', 'Paiement QR — Utilisateur → Marchand'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'consumption', '467100', '401000', 'Conso K — Utilisateur → Dette marchand local'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'settlement', '401000', '512000', 'Reglement marchand — Dette → Banque'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'refund', '467100', '512000', 'Remboursement — Utilisateur ← Banque'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'fee_collection', '467100', '708000', 'Commission — Utilisateur → Produits'
    FROM konektag.legal_entities WHERE code = 'KTG-FR'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    -- KTG-CG
    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'acquisition', '521000', '467100', 'Recharge K — Banque/MoMo → Utilisateurs'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'gift', '467100', '467100', 'Cadeau K — Utilisateur A → Utilisateur B'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'qr_payment', '467100', '401000', 'Paiement QR — Utilisateur → Marchand'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'consumption', '467100', '401000', 'Conso K — Utilisateur → Dette marchand local'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'settlement', '401000', '521000', 'Reglement marchand — Dette → MoMo/Banque'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'refund', '467100', '521000', 'Remboursement — Utilisateur ← Banque/MoMo'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;

    INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
    SELECT id, 'fee_collection', '467100', '708000', 'Commission — Utilisateur → Produits'
    FROM konektag.legal_entities WHERE code = 'KTG-CG'
    ON CONFLICT (legal_entity_id, event_type) DO NOTHING;
  END IF;
END $$;

-- Recreer daily_reconciliations si detruite
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'konektag' AND table_name = 'daily_reconciliations') THEN
    CREATE TABLE IF NOT EXISTS konektag.daily_reconciliations (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reconciliation_date DATE NOT NULL,
        gl_name             VARCHAR(50) NOT NULL,
        rail                VARCHAR(30),
        expected_balance    NUMERIC(20,2),
        actual_balance      NUMERIC(20,2),
        difference          NUMERIC(20,2),
        status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'MATCHED', 'MISMATCH', 'INVESTIGATING', 'RESOLVED')),
        exceptions          JSONB DEFAULT '[]',
        reconciled_by       UUID,
        reconciled_at       TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (reconciliation_date, gl_name, rail)
    );
  END IF;
END $$;

COMMIT;
