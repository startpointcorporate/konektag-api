BEGIN;

ALTER TABLE konektag.user_preferences
  ADD COLUMN IF NOT EXISTS preferred_currency varchar(3);

ALTER TABLE konektag.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_preferred_currency_check;
ALTER TABLE konektag.user_preferences
  ADD CONSTRAINT user_preferences_preferred_currency_check
  CHECK (preferred_currency IS NULL OR preferred_currency IN ('XOF','XAF','EUR','USD','LBP','AOA','CDF','GNF'));

COMMIT;
