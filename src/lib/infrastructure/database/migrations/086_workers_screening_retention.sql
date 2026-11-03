-- Migration 086 : Workers, screening, retention
-- Outbox claim improvements, ERP configuration validation, PII audit controls.

BEGIN;

-- 1. Outbox claim_token for at-least-once delivery
ALTER TABLE konektag.accounting_outbox ADD COLUMN IF NOT EXISTS claim_token VARCHAR(64);
ALTER TABLE konektag.accounting_outbox ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON konektag.accounting_outbox(claim_token);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON konektag.accounting_outbox(status, next_attempt_at);

-- 2. Add purge tracking to KYC records
ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ;
ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN DEFAULT false;
ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
ALTER TABLE konektag.kyc_orders ADD COLUMN IF NOT EXISTS purge_minio_objects JSONB DEFAULT '[]';

-- 3. Screening batch source tracking
ALTER TABLE konektag.screening_batches ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE konektag.screening_batches ADD COLUMN IF NOT EXISTS source_version VARCHAR(20);
ALTER TABLE konektag.screening_batches ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64);
ALTER TABLE konektag.screening_batches ADD COLUMN IF NOT EXISTS source_date DATE;

-- 4. Screening entry normalization
ALTER TABLE konektag.screening_entries ADD COLUMN IF NOT EXISTS pep_match BOOLEAN DEFAULT false;
ALTER TABLE konektag.screening_entries ADD COLUMN IF NOT EXISTS matched_entity_type VARCHAR(30);
ALTER TABLE konektag.screening_entries ADD COLUMN IF NOT EXISTS matched_entity_id VARCHAR(200);

-- 5. ERP configuration validation record
CREATE TABLE IF NOT EXISTS konektag.erp_configurations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    configuration_key   VARCHAR(50) NOT NULL UNIQUE,
    configuration_value TEXT,
    is_valid            BOOLEAN NOT NULL DEFAULT false,
    validation_error    TEXT,
    validated_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Audit log PII policy: add redacted flag
ALTER TABLE konektag.audit_logs ADD COLUMN IF NOT EXISTS redacted BOOLEAN DEFAULT false;

COMMIT;
