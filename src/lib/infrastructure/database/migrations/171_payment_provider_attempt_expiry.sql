BEGIN;
ALTER TABLE konektag.payment_provider_attempts
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE konektag.payment_provider_attempts
SET expires_at = created_at + interval '30 minutes'
WHERE expires_at IS NULL AND state IN ('pending','processing');
ALTER TABLE konektag.payment_provider_attempts
  DROP CONSTRAINT IF EXISTS payment_provider_attempts_state_check;
ALTER TABLE konektag.payment_provider_attempts
  ADD CONSTRAINT payment_provider_attempts_state_check
  CHECK (state IN ('pending','processing','succeeded','failed','cancelled','expired'));
CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_active_expiry
  ON konektag.payment_provider_attempts(expires_at)
  WHERE state IN ('pending','processing');
COMMIT;
