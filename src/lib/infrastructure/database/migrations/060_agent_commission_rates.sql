-- Migration 060: agent commission rates per country per merchant
CREATE TABLE IF NOT EXISTS konektag.agent_commission_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
    country_code        VARCHAR(2) NOT NULL,
    commission_rate     NUMERIC(5,2) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 100),
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER NOT NULL DEFAULT 1,
    UNIQUE(merchant_profile_id, country_code)
);

CREATE INDEX IF NOT EXISTS idx_agent_commission_rates_merchant ON konektag.agent_commission_rates(merchant_profile_id);
