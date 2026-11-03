CREATE TABLE IF NOT EXISTS konektag.merchant_api_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    public_key          VARCHAR(80) NOT NULL,
    secret_key_hash     VARCHAR(64) NOT NULL,
    environment         VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox', 'live')),
    is_revoked          BOOLEAN NOT NULL DEFAULT false,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_profile_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_merchant_api_keys_profile ON konektag.merchant_api_keys(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_merchant_api_keys_hash ON konektag.merchant_api_keys(secret_key_hash) WHERE NOT is_revoked;

COMMENT ON TABLE konektag.merchant_api_keys IS 'Clés API marchandes pour intégration REST';
COMMENT ON COLUMN konektag.merchant_api_keys.public_key IS 'Clé publique (pk_live_* ou pk_test_*)';
COMMENT ON COLUMN konektag.merchant_api_keys.secret_key_hash IS 'SHA-256 de la clé secrète (sk_live_* ou sk_test_*)';
COMMENT ON COLUMN konektag.merchant_api_keys.environment IS 'sandbox ou live';
