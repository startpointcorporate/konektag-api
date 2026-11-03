BEGIN;
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS country_confirmed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_country_confirmation_due
  ON konektag.users(country_confirmed_at)
  WHERE deleted_at IS NULL AND state='COMPLETED';
COMMIT;
