-- Migration 101: encrypt beneficiary contact and banking data at rest.
-- There is no legacy beneficiary data at cutover.
BEGIN;

ALTER TABLE konektag.gift_beneficiaries
    ADD COLUMN IF NOT EXISTS phone_number_encrypted BYTEA,
    ADD COLUMN IF NOT EXISTS phone_number_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS bank_account_encrypted BYTEA;

DROP INDEX IF EXISTS konektag.uq_gift_beneficiary_owner_phone_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_beneficiary_owner_phone_hash_active
    ON konektag.gift_beneficiaries(owner_keycloak_id, phone_number_hash)
    WHERE deleted_at IS NULL AND is_active = true;

ALTER TABLE konektag.gift_beneficiaries
    ALTER COLUMN phone_number_encrypted SET NOT NULL,
    ALTER COLUMN phone_number_hash SET NOT NULL,
    DROP COLUMN IF EXISTS phone_number,
    DROP COLUMN IF EXISTS bank_account;

COMMIT;
