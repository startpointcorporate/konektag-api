BEGIN;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS kyb_submitted_at TIMESTAMPTZ;
UPDATE konektag.merchant_profiles
SET kyb_submitted_at = certification_submitted_at
WHERE kyb_status <> 'NOT_STARTED' AND kyb_submitted_at IS NULL AND certification_submitted_at IS NOT NULL;
COMMIT;
