-- Migration 098: PostgreSQL gift intent/read model and beneficiary address book.
BEGIN;

CREATE TABLE IF NOT EXISTS konektag.gift_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_user_id UUID NOT NULL REFERENCES konektag.users(id),
    sender_keycloak_id VARCHAR(100) NOT NULL,
    recipient_user_id UUID NOT NULL REFERENCES konektag.users(id),
    recipient_keycloak_id VARCHAR(100) NOT NULL,
    recipient_name VARCHAR(200) NOT NULL,
    origin_country VARCHAR(5) NOT NULL,
    destination_country VARCHAR(5) NOT NULL,
    source_amount BIGINT NOT NULL CHECK (source_amount > 0),
    source_currency VARCHAR(3) NOT NULL,
    fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
    total_amount BIGINT NOT NULL CHECK (total_amount = source_amount + fee_amount),
    receive_amount BIGINT NOT NULL CHECK (receive_amount = source_amount),
    cashback_amount BIGINT NOT NULL DEFAULT 0 CHECK (cashback_amount >= 0),
    quote_expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Quoted', 'PendingFunding', 'Funded', 'Cancelled')),
    funding_method VARCHAR(30) NOT NULL DEFAULT 'Solde Konektag',
    funding_reference VARCHAR(200),
    financial_transaction_id UUID REFERENCES konektag.financial_transactions(id),
    operation_id UUID,
    gift_depth INTEGER,
    note TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    funded_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gift_intents_sender_created
    ON konektag.gift_intents(sender_keycloak_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_intents_recipient
    ON konektag.gift_intents(recipient_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_intents_financial_transaction
    ON konektag.gift_intents(financial_transaction_id)
    WHERE financial_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS konektag.gift_beneficiaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_keycloak_id VARCHAR(100) NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    country VARCHAR(5) NOT NULL,
    operator VARCHAR(100) NOT NULL,
    bank_account VARCHAR(200),
    relationship VARCHAR(100) NOT NULL DEFAULT 'Autre',
    is_active BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_beneficiary_owner_phone_active
    ON konektag.gift_beneficiaries(owner_keycloak_id, phone_number)
    WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_gift_beneficiary_owner
    ON konektag.gift_beneficiaries(owner_keycloak_id, created_at DESC)
    WHERE deleted_at IS NULL AND is_active = true;

COMMIT;
