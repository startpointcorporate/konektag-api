BEGIN;
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS kyb_ubo_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kyb_sanctions_screened BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kyb_documents_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS kyb_complement_reason TEXT;
COMMIT;
