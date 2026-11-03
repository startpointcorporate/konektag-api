-- Migration 001 : Création du schéma konektag et des tables onboarding/KYC
-- Version : 1.0 | Idempotent

CREATE SCHEMA IF NOT EXISTS konektag;

-- ═══ USERS ═══
CREATE TABLE IF NOT EXISTS konektag.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_id     UUID NOT NULL UNIQUE,
    username        VARCHAR(50) NOT NULL UNIQUE,
    email_hash      VARCHAR(64) NOT NULL UNIQUE,
    phone_hash      VARCHAR(64),
    locale          VARCHAR(5) NOT NULL DEFAULT 'fr',
    state           VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
                    CHECK (state IN (
                        'DRAFT','ACCOUNT_CREATED','OTP_VERIFIED',
                        'KYC_PENDING','KYC_PROCESSING','KYC_VALIDATED',
                        'KYC_REJECTED','KYC_SKIPPED','FEATURES_SELECTED','COMPLETED'
                    )),
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    phone_verified  BOOLEAN NOT NULL DEFAULT false,
    encrypted_data  BYTEA NOT NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMP WITH TIME ZONE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_by      UUID,
    updated_by      UUID
);

CREATE INDEX IF NOT EXISTS idx_users_email_hash ON konektag.users(email_hash);
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON konektag.users(phone_hash);
CREATE INDEX IF NOT EXISTS idx_users_keycloak_id ON konektag.users(keycloak_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON konektag.users(username);

-- ═══ KYC ORDERS ═══
CREATE TABLE IF NOT EXISTS konektag.kyc_orders (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES konektag.users(id),
    status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                          'pending','quarantined','scanning','processing',
                          'verified','rejected'
                      )),
    id_document_path  VARCHAR(500),
    selfie_path       VARCHAR(500),
    ocr_data          JSONB,
    clamav_result     JSONB,
    face_match_result JSONB,
    liveness_result   JSONB,
    rejection_reason  TEXT,
    attempt           INTEGER NOT NULL DEFAULT 1,
    n8n_execution_id  VARCHAR(100),
    correlation_id    UUID NOT NULL,
    verified_at       TIMESTAMP WITH TIME ZONE,
    expires_at        TIMESTAMP WITH TIME ZONE,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMP WITH TIME ZONE,
    version           INTEGER NOT NULL DEFAULT 1,
    created_by        UUID,
    updated_by        UUID
);

CREATE INDEX IF NOT EXISTS idx_kyc_orders_user_id ON konektag.kyc_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_orders_status ON konektag.kyc_orders(status);

-- ═══ USER PREFERENCES ═══
CREATE TABLE IF NOT EXISTS konektag.user_preferences (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL UNIQUE REFERENCES konektag.users(id),
    selected_features JSONB NOT NULL DEFAULT '[]',
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMP WITH TIME ZONE,
    version           INTEGER NOT NULL DEFAULT 1,
    created_by        UUID,
    updated_by        UUID
);

-- ═══ FEATURES ═══
CREATE TABLE IF NOT EXISTS konektag.features (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_key  VARCHAR(50) NOT NULL UNIQUE,
    name_i18n    JSONB NOT NULL,
    icon         VARCHAR(100) NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    is_required  BOOLEAN NOT NULL DEFAULT false,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMP WITH TIME ZONE,
    version      INTEGER NOT NULL DEFAULT 1
);

-- ═══ AUDIT LOG ═══
CREATE TABLE IF NOT EXISTS konektag.audit_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID REFERENCES konektag.users(id),
    correlation_id   UUID NOT NULL,
    event_type       VARCHAR(50) NOT NULL,
    payload          JSONB,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON konektag.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON konektag.audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON konektag.audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON konektag.audit_logs(created_at);

-- ═══ IDEMPOTENCY KEYS ═══
CREATE TABLE IF NOT EXISTS konektag.idempotency_keys (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  VARCHAR(100) NOT NULL UNIQUE,
    request_hash     VARCHAR(64) NOT NULL,
    response_status  INTEGER,
    response_body    JSONB,
    expires_at       TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_key ON konektag.idempotency_keys(idempotency_key);

-- ═══ OUTBOX EVENTS ═══
CREATE TABLE IF NOT EXISTS konektag.outbox_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id    UUID NOT NULL,
    aggregate_type    VARCHAR(50) NOT NULL,
    aggregate_id      UUID NOT NULL,
    event_type        VARCHAR(100) NOT NULL,
    event_version     INTEGER NOT NULL DEFAULT 1,
    payload           JSONB NOT NULL,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    processed_at      TIMESTAMP WITH TIME ZONE,
    attempts          INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON konektag.outbox_events(created_at, id)
    WHERE processed_at IS NULL;

-- ═══ CONFIGURATION ═══
CREATE TABLE IF NOT EXISTS konektag.configurations (
    key         VARCHAR(100) PRIMARY KEY,
    value       JSONB NOT NULL,
    description TEXT,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    version     INTEGER NOT NULL DEFAULT 1
);

-- ═══ TRIGGER : updated_at automatique ═══
CREATE OR REPLACE FUNCTION konektag.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'konektag'
          AND tablename IN ('users','kyc_orders','user_preferences','features','configurations')
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I_updated_at ON konektag.%I;
             CREATE TRIGGER %I_updated_at BEFORE UPDATE ON konektag.%I
             FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at()',
            t, t, t, t
        );
    END LOOP;
END $$;

-- ═══ FONCTION : NOTIFY outbox ═══
CREATE OR REPLACE FUNCTION konektag.notify_outbox()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('outbox_channel', NEW.id::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outbox_notify ON konektag.outbox_events;
CREATE TRIGGER outbox_notify
    AFTER INSERT ON konektag.outbox_events
    FOR EACH ROW EXECUTE FUNCTION konektag.notify_outbox();
