-- Migration 037 : Projection marketing utilisateur
-- Table dédiée, recalculable depuis les sources transactionnelles.
-- Ne modifie pas konektag.users.

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.user_marketing_metrics (
    user_id                    UUID PRIMARY KEY REFERENCES konektag.users(id),
    wallet_funded_once         BOOLEAN NOT NULL DEFAULT false,
    transfer_count             INTEGER NOT NULL DEFAULT 0,
    merchant_payment_count     INTEGER NOT NULL DEFAULT 0,
    first_business_activity_at TIMESTAMPTZ,
    last_business_activity_at  TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE konektag.user_marketing_metrics IS 'Projection marketing — recalculable depuis les sources transactionnelles';

CREATE OR REPLACE FUNCTION konektag.refresh_user_marketing_metrics(p_user_id UUID)
RETURNS konektag.user_marketing_metrics AS $$
DECLARE
    v_wallet_funded         BOOLEAN;
    v_transfer_count        INTEGER;
    v_payment_count         INTEGER;
    v_first_activity        TIMESTAMPTZ;
    v_last_activity         TIMESTAMPTZ;
    v_result                konektag.user_marketing_metrics;
    v_client_id             VARCHAR(255);
BEGIN
    v_client_id := p_user_id::varchar;

    SELECT EXISTS(
        SELECT 1 FROM konektag.ledger_entries
        WHERE client_id = v_client_id AND document_type = 'Recharge' AND entry_type = 'credit'
    ) INTO v_wallet_funded;

    SELECT COUNT(*)::integer FROM konektag.ledger_entries
    WHERE client_id = v_client_id AND document_type = 'TransferSent' AND entry_type = 'debit'
    INTO v_transfer_count;

    SELECT COUNT(*)::integer FROM konektag.financial_transactions ft
    JOIN konektag.ledger_entries le ON le.transaction_id = ft.id
    JOIN konektag.parties p ON p.id = le.party_id
    WHERE p.keycloak_id = (SELECT keycloak_id FROM konektag.users WHERE id = p_user_id)
      AND ft.transaction_type = 'qr_payment'
      AND ft.status = 'completed'
      AND le.entry_side = 'debit'
    INTO v_payment_count;

    SELECT MIN(created_at), MAX(created_at) FROM (
        SELECT created_at FROM konektag.ledger_entries
        WHERE client_id = v_client_id AND document_type IN ('Recharge', 'TransferSent')
        UNION ALL
        SELECT ft.created_at FROM konektag.financial_transactions ft
        JOIN konektag.ledger_entries le ON le.transaction_id = ft.id
        JOIN konektag.parties p ON p.id = le.party_id
        WHERE p.keycloak_id = (SELECT keycloak_id FROM konektag.users WHERE id = p_user_id)
          AND ft.transaction_type = 'qr_payment'
          AND ft.status = 'completed'
          AND le.entry_side = 'debit'
    ) AS acts
    INTO v_first_activity, v_last_activity;

    INSERT INTO konektag.user_marketing_metrics
        (user_id, wallet_funded_once, transfer_count, merchant_payment_count,
         first_business_activity_at, last_business_activity_at)
    VALUES (p_user_id, v_wallet_funded, v_transfer_count, v_payment_count,
            v_first_activity, v_last_activity)
    ON CONFLICT (user_id) DO UPDATE SET
        wallet_funded_once         = EXCLUDED.wallet_funded_once,
        transfer_count             = EXCLUDED.transfer_count,
        merchant_payment_count     = EXCLUDED.merchant_payment_count,
        first_business_activity_at = EXCLUDED.first_business_activity_at,
        last_business_activity_at  = EXCLUDED.last_business_activity_at,
        updated_at                 = now()
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_ledger_client_type ON konektag.ledger_entries(client_id, document_type, entry_type);
CREATE INDEX IF NOT EXISTS idx_financial_tx_type_status ON konektag.financial_transactions(transaction_type, status);

COMMIT;
