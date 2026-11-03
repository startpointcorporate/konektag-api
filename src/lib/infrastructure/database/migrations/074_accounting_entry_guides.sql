-- Migration 074 : Guides d'ecriture par entite legale
-- Remplace le ACCOUNT_MAP global hardcode par evenement
-- Chaque entite (KTG-FR, KTG-CG) a son propre debit/credit par type d'operation

BEGIN;

DROP TABLE IF EXISTS konektag.accounting_mappings CASCADE;

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
    CONSTRAINT uq_entry_guide UNIQUE (legal_entity_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_entry_guides_entity ON konektag.accounting_entry_guides(legal_entity_id) WHERE deleted_at IS NULL;

-- Seeds : guides d'ecriture par defaut pour KTG-FR (PCG France)
INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
SELECT id, 'acquisition', '512000', '467100', 'Recharge K — Banque → Utilisateurs'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'gift', '467100', '467100', 'Cadeau K — Utilisateur A → Utilisateur B'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'qr_payment', '467100', '401000', 'Paiement QR — Utilisateur → Marchand'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'consumption', '467100', '401000', 'Conso K — Utilisateur → Dette marchand local'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'settlement', '401000', '512000', 'Reglement marchand — Dette → Banque'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'refund', '467100', '512000', 'Remboursement — Utilisateur ← Banque'
FROM konektag.legal_entities WHERE code = 'KTG-FR'
UNION ALL
SELECT id, 'fee_collection', '467100', '708000', 'Commission — Utilisateur → Produits'
FROM konektag.legal_entities WHERE code = 'KTG-FR';

-- Seeds : guides d'ecriture pour KTG-CG (SYSCOHADA)
INSERT INTO konektag.accounting_entry_guides (legal_entity_id, event_type, debit_account, credit_account, description)
SELECT id, 'acquisition', '521000', '467100', 'Recharge K — Banque/MoMo → Utilisateurs'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'gift', '467100', '467100', 'Cadeau K — Utilisateur A → Utilisateur B'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'qr_payment', '467100', '401000', 'Paiement QR — Utilisateur → Marchand'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'consumption', '467100', '401000', 'Conso K — Utilisateur → Dette marchand local'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'settlement', '401000', '521000', 'Reglement marchand — Dette → MoMo/Banque'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'refund', '467100', '521000', 'Remboursement — Utilisateur ← Banque/MoMo'
FROM konektag.legal_entities WHERE code = 'KTG-CG'
UNION ALL
SELECT id, 'fee_collection', '467100', '708000', 'Commission — Utilisateur → Produits'
FROM konektag.legal_entities WHERE code = 'KTG-CG';

COMMIT;
