-- Migration 083 : Gifts, checkout intents, merchant checkout
-- Common checkout_intents table for QR and Link.

BEGIN;

-- 1. Checkout intents table (QR + Link shared)
CREATE TABLE IF NOT EXISTS konektag.checkout_intents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash          VARCHAR(64) NOT NULL,
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
    amount              DECIMAL NOT NULL,
    currency            VARCHAR(3) NOT NULL,
    service_description TEXT,
    quote_valuation     JSONB,
    regulatory_profile_id UUID REFERENCES konektag.regulatory_profiles(id),
    klot_id             UUID REFERENCES konektag.klots(id),
    allocation_rule     JSONB,
    expiration          TIMESTAMPTZ NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'ISSUED'
                            CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
    operation_id        UUID,
    usage_unique        BOOLEAN NOT NULL DEFAULT true,
    version             INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_token_hash ON konektag.checkout_intents(token_hash);
CREATE INDEX IF NOT EXISTS idx_checkout_merchant ON konektag.checkout_intents(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_checkout_status ON konektag.checkout_intents(status);

-- 2. Gift depth tracking
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_depth INTEGER DEFAULT 0;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_origin_user_id UUID;

-- 3. Add gift chain control fields
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_chain_id UUID;
ALTER TABLE konektag.financial_transactions ADD COLUMN IF NOT EXISTS gift_chain_position INTEGER DEFAULT 0;

COMMIT;
