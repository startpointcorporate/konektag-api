-- Migration 032 : Infrastructure comptable — financial_transactions, comptes, parties
-- Idempotent : toutes les instructions utilisent IF NOT EXISTS / IF EXISTS

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. PARTIES — identité financière (utilisateur, commerçant, etc.)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.parties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    party_type      VARCHAR(20) NOT NULL CHECK (party_type IN (
                        'individual', 'merchant', 'organization',
                        'platform', 'operator', 'bank'
                    )),
    keycloak_id     UUID UNIQUE,
    legal_name      VARCHAR(200),
    display_name    VARCHAR(200) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(50),
    country         VARCHAR(5),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index : recherche par keycloak_id (lien avec auth)
CREATE INDEX IF NOT EXISTS idx_parties_keycloak ON konektag.parties(keycloak_id);

-- ═══════════════════════════════════════════════════════════════
-- 2. COMPTES FINANCIERS — plan comptable interne Konektag
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.financial_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code    VARCHAR(20) NOT NULL UNIQUE,
    account_name    VARCHAR(200) NOT NULL,
    account_type    VARCHAR(20) NOT NULL CHECK (account_type IN (
                        'asset', 'liability', 'equity', 'revenue', 'expense'
                    )),
    is_system       BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_cash         BOOLEAN NOT NULL DEFAULT false,
    parent_code     VARCHAR(20) REFERENCES konektag.financial_accounts(account_code),
    party_id        UUID REFERENCES konektag.parties(id),
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_accounts_type ON konektag.financial_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_financial_accounts_party ON konektag.financial_accounts(party_id) WHERE party_id IS NOT NULL;

-- Seed des comptes systèmes (idempotent via ON CONFLICT)
INSERT INTO konektag.financial_accounts (account_code, account_name, account_type, is_system, is_cash, description) VALUES
    ('1000', 'Wallet Utilisateurs',   'asset',     true, true,  'Soldes des portefeuilles utilisateurs'),
    ('1100', 'Wallet Commerçants',    'asset',     true, true,  'Soldes des portefeuilles commerçants'),
    ('2000', 'Dettes Commerçants',    'liability', true, false, 'Montants dus aux commerçants'),
    ('3000', 'Frais Plateforme',      'revenue',   true, false, 'Commissions et frais perçus'),
    ('3100', 'Frais Opérateur',       'expense',   true, false, 'Frais payés aux opérateurs Mobile Money'),
    ('4000', 'Cashback à Servir',     'liability', true, false, 'Cashback promis non encore versé'),
    ('4100', 'Cashback Distribué',    'expense',   true, false, 'Cashback effectivement versé'),
    ('5000', 'Commissions Ambassadeurs à Payer', 'liability', true, false, 'Commissions dues aux ambassadeurs'),
    ('6000', 'Mobile Money Clearing', 'asset',     true, true,  'Comptes de transit Mobile Money'),
    ('7000', 'Banque Clearing',       'asset',     true, true,  'Comptes de transit bancaires'),
    ('8000', 'Suspense',              'asset',     true, false, 'Écarts et opérations non identifiées'),
    ('9000', 'Remboursements à Payer','liability', true, false, 'Montants dus suite à des remboursements')
ON CONFLICT (account_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 3. TRANSACTIONS FINANCIÈRES — en-tête de chaque opération
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.financial_transactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_type        VARCHAR(30) NOT NULL,
    business_reference      VARCHAR(100) NOT NULL,
    idempotency_key         VARCHAR(200) NOT NULL UNIQUE,
    currency                VARCHAR(10) NOT NULL DEFAULT 'XOF',
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
    accounting_status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (accounting_status IN ('pending', 'processing', 'posted', 'failed', 'reversed')),
    erpnext_voucher_type    VARCHAR(30),
    erpnext_voucher_id      VARCHAR(100),
    reversed_transaction_id UUID REFERENCES konektag.financial_transactions(id),
    error_message           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ,
    failed_at               TIMESTAMPTZ,
    accounting_posted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fin_tx_status ON konektag.financial_transactions(status);
CREATE INDEX IF NOT EXISTS idx_fin_tx_accounting ON konektag.financial_transactions(accounting_status) WHERE accounting_status IN ('pending', 'processing', 'failed');
CREATE INDEX IF NOT EXISTS idx_fin_tx_idempotency ON konektag.financial_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_fin_tx_business_ref ON konektag.financial_transactions(business_reference);

-- ═══════════════════════════════════════════════════════════════
-- 4. ÉVOLUTION DE ledger_entries — ajout des colonnes comptables
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE konektag.ledger_entries
    ADD COLUMN IF NOT EXISTS transaction_id UUID,
    ADD COLUMN IF NOT EXISTS entry_side VARCHAR(10),
    ADD COLUMN IF NOT EXISTS account_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS party_id UUID,
    ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reversed_entry_id UUID;

-- Rendre client_id nullable (remplacé progressivement par party_id)
ALTER TABLE konektag.ledger_entries ALTER COLUMN client_id DROP NOT NULL;

-- Rétrofit : copier entry_type → entry_side
UPDATE konektag.ledger_entries SET entry_side = entry_type WHERE entry_side IS NULL;

-- Rendre entry_side NOT NULL après le backfill
ALTER TABLE konektag.ledger_entries ALTER COLUMN entry_side SET NOT NULL;

-- Contrainte CHECK sur entry_side (même domaine que entry_type)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_ledger_entry_side'
    ) THEN
        ALTER TABLE konektag.ledger_entries
            ADD CONSTRAINT ck_ledger_entry_side
            CHECK (entry_side IN ('debit', 'credit'));
    END IF;
END $$;

-- Ajouter les FK (sans NOT NULL — rétrocompatibilité)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_transaction'
    ) THEN
        ALTER TABLE konektag.ledger_entries
            ADD CONSTRAINT fk_ledger_transaction
            FOREIGN KEY (transaction_id) REFERENCES konektag.financial_transactions(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_account'
    ) THEN
        ALTER TABLE konektag.ledger_entries
            ADD CONSTRAINT fk_ledger_account
            FOREIGN KEY (account_code) REFERENCES konektag.financial_accounts(account_code);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_party'
    ) THEN
        ALTER TABLE konektag.ledger_entries
            ADD CONSTRAINT fk_ledger_party
            FOREIGN KEY (party_id) REFERENCES konektag.parties(id);
    END IF;
END $$;

-- Index pour les performances
CREATE INDEX IF NOT EXISTS idx_ledger_transaction_id ON konektag.ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_code ON konektag.ledger_entries(account_code);
CREATE INDEX IF NOT EXISTS idx_ledger_party ON konektag.ledger_entries(party_id);
CREATE INDEX IF NOT EXISTS idx_ledger_side ON konektag.ledger_entries(entry_side);

-- ═══════════════════════════════════════════════════════════════
-- 5. IMMUTABILITÉ — interdire UPDATE / DELETE sur les écritures
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION konektag.block_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Ledger entries are immutable: UPDATE/DELETE not allowed. Create a reversal transaction instead.'
        USING HINT = 'Use a financial_transaction with reversed_transaction_id to correct errors.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_no_update ON konektag.ledger_entries;
CREATE TRIGGER trg_ledger_no_update
    BEFORE UPDATE ON konektag.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION konektag.block_ledger_mutation();

DROP TRIGGER IF EXISTS trg_ledger_no_delete ON konektag.ledger_entries;
CREATE TRIGGER trg_ledger_no_delete
    BEFORE DELETE ON konektag.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION konektag.block_ledger_mutation();

-- ═══════════════════════════════════════════════════════════════
-- 6. VALIDATION PARTIE DOUBLE — vérifiée au COMMIT
-- ═══════════════════════════════════════════════════════════════
-- Constraint trigger deferrable : la validation a lieu au COMMIT,
-- une fois que toutes les lignes de la transaction sont insérées.
CREATE OR REPLACE FUNCTION konektag.check_balanced_transaction()
RETURNS TRIGGER AS $$
DECLARE
    _debit  BIGINT;
    _credit BIGINT;
    _txn_id UUID;
BEGIN
    _txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
    IF _txn_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT
        COALESCE(SUM(CASE WHEN entry_side = 'debit'  THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE 0 END), 0)
    INTO _debit, _credit
    FROM konektag.ledger_entries
    WHERE transaction_id = _txn_id;

    IF _debit != _credit THEN
        RAISE EXCEPTION 'Unbalanced transaction %: debit % ≠ credit %',
            _txn_id, _debit, _credit
            USING HINT = 'Total debits must equal total credits for each transaction.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON konektag.ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
    AFTER INSERT OR UPDATE ON konektag.ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION konektag.check_balanced_transaction();

-- ═══════════════════════════════════════════════════════════════
-- 7. OUTBOX COMPTABLE — événements pour le worker ERPNext
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE konektag.financial_transactions
    ADD COLUMN IF NOT EXISTS outbox_event_id UUID;

-- ═══════════════════════════════════════════════════════════════
-- 8. updated_at trigger pour parties
-- ═══════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_parties_updated_at ON konektag.parties;
CREATE TRIGGER trg_parties_updated_at
    BEFORE UPDATE ON konektag.parties
    FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();

COMMIT;
