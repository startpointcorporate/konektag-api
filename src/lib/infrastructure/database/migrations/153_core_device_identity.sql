-- Migration 153: Core device identity and related tables
-- Adds core_device_keys, core_device_certificates, core_key_revocations
-- with associated constraints and triggers for immutability rules.

-- Ensure we are using the correct schema


-- -----------------------------------------------------------------------------
-- 1️⃣  core_device_keys
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS konektag.core_device_keys (
    key_id          UUID PRIMARY KEY,
    device_id       UUID NOT NULL,
    owner_user_id   UUID NOT NULL,
    version         INT NOT NULL CHECK (version > 0),
    public_key      JSONB NOT NULL CHECK (jsonb_typeof(public_key)='object' AND public_key ?& ARRAY['kty','crv','x','y'] AND public_key->>'kty'='EC' AND public_key->>'crv'='P-256' AND public_key->>'x' ~ '^[A-Za-z0-9_-]{43}$' AND public_key->>'y' ~ '^[A-Za-z0-9_-]{43}$' AND NOT public_key ? 'd'),
    activated_at    TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('ACTIVE','RETIRING','REVOKED')),
    retire_at       TIMESTAMPTZ,
    CHECK (state <> 'RETIRING' OR retire_at IS NOT NULL),
    CONSTRAINT fk_device_owner
        FOREIGN KEY (device_id, owner_user_id)
        REFERENCES konektag.core_offline_devices(id, owner_user_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_retire_between
        CHECK (retire_at IS NULL OR (retire_at > activated_at AND retire_at <= expires_at)),
    CONSTRAINT ck_expires_window
        CHECK (expires_at > activated_at AND expires_at <= activated_at + INTERVAL '30 day')
);

-- Unique constraints
ALTER TABLE konektag.core_device_keys ADD CONSTRAINT uq_device_version UNIQUE (device_id, version);
ALTER TABLE konektag.core_device_keys ADD CONSTRAINT uq_device_key UNIQUE (device_id, key_id);

-- Partial unique index for active key per device
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_active_key ON konektag.core_device_keys(device_id) WHERE state = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 2️⃣  core_device_certificates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS konektag.core_device_certificates (
    certificate_id     UUID PRIMARY KEY,
    key_id             UUID NOT NULL,
    token              TEXT NOT NULL,
    activated_at       TIMESTAMPTZ NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    merchant_profile_id UUID,
    usage              TEXT NOT NULL CHECK (usage IN ('DEVICE','QR_PAYMENT')),
    CONSTRAINT fk_cert_key
        FOREIGN KEY (key_id)
        REFERENCES konektag.core_device_keys(key_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_cert_merchant
        FOREIGN KEY (merchant_profile_id)
        REFERENCES konektag.merchant_profiles(id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_token_length
        CHECK (char_length(token) <= 4096),
    CONSTRAINT ck_expires_window_cert
        CHECK (expires_at > activated_at AND expires_at <= activated_at + INTERVAL '24 hour'),
    CONSTRAINT ck_usage_merchant
        CHECK ((usage = 'DEVICE' AND merchant_profile_id IS NULL)
               OR (usage = 'QR_PAYMENT' AND merchant_profile_id IS NOT NULL))
);

-- Unique token constraint
ALTER TABLE konektag.core_device_certificates ADD CONSTRAINT uq_cert_token UNIQUE (token);

-- -----------------------------------------------------------------------------
-- 3️⃣  core_key_revocations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS konektag.core_key_revocations (
    revision     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key_id       UUID NOT NULL,
    device_id    UUID NOT NULL,
    revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason       TEXT NOT NULL CHECK (char_length(reason) >= 1 AND char_length(reason) <= 240),
    CONSTRAINT fk_revocation
        FOREIGN KEY (key_id, device_id)
        REFERENCES konektag.core_device_keys(key_id, device_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_revocation_key UNIQUE (key_id)
);

-- -----------------------------------------------------------------------------
-- 4️⃣  Triggers and functions for immutability constraints
-- -----------------------------------------------------------------------------

-- Function to prevent updates of immutable columns on core_device_keys
CREATE OR REPLACE FUNCTION konektag.fn_prevent_key_update() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.retire_at > now() + INTERVAL '24 hours' OR (OLD.retire_at IS NOT NULL AND (NEW.retire_at IS NULL OR NEW.retire_at > OLD.retire_at)) THEN RAISE EXCEPTION 'Retirement window cannot be extended'; END IF;
        IF NEW.key_id <> OLD.key_id OR
           NEW.device_id <> OLD.device_id OR
           NEW.owner_user_id <> OLD.owner_user_id OR
           NEW.version <> OLD.version OR
           NEW.public_key <> OLD.public_key OR
           NEW.activated_at <> OLD.activated_at OR
           NEW.expires_at <> OLD.expires_at THEN
            RAISE EXCEPTION 'Immutable column(s) changed on core_device_keys';
        END IF;
        IF OLD.state = 'REVOKED' AND NEW.state <> 'REVOKED' THEN
            RAISE EXCEPTION 'Cannot change state from REVOKED to %', NEW.state;
        END IF;
        IF OLD.state = 'RETIRING' AND NEW.state = 'ACTIVE' THEN
            RAISE EXCEPTION 'Cannot change state from RETIRING to ACTIVE';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Prevent delete on core_device_keys to preserve references
CREATE OR REPLACE FUNCTION konektag.fn_prevent_key_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of core_device_keys is forbidden to preserve references';
END;
$$ LANGUAGE plpgsql;

-- Trigger for updates of core_device_keys
CREATE TRIGGER trg_prevent_key_update
BEFORE UPDATE ON konektag.core_device_keys
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_key_update();

-- Trigger for deletion on core_device_keys
CREATE TRIGGER trg_prevent_key_delete
BEFORE DELETE ON konektag.core_device_keys
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_key_delete();

-- Function & trigger to prevent ANY update or delete on core_device_certificates
CREATE OR REPLACE FUNCTION konektag.fn_prevent_certificate_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Modification of core_device_certificates is forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_certificate_update
BEFORE UPDATE ON konektag.core_device_certificates
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_certificate_change();

CREATE TRIGGER trg_prevent_certificate_delete
BEFORE DELETE ON konektag.core_device_certificates
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_certificate_change();

-- Function & trigger to prevent ANY update or delete on core_key_revocations
CREATE OR REPLACE FUNCTION konektag.fn_prevent_revocation_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Modification of core_key_revocations is forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_revocation_update
BEFORE UPDATE ON konektag.core_key_revocations
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_revocation_change();

CREATE TRIGGER trg_prevent_revocation_delete
BEFORE DELETE ON konektag.core_key_revocations
FOR EACH ROW EXECUTE FUNCTION konektag.fn_prevent_revocation_change();

-- End of migration 153
