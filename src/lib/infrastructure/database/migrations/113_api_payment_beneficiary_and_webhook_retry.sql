ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS beneficiary_type TEXT DEFAULT 'MERCHANT';

UPDATE konektag.merchant_profiles
SET beneficiary_type = 'MERCHANT'
WHERE beneficiary_type IS NULL;

ALTER TABLE konektag.merchant_profiles
  ALTER COLUMN beneficiary_type SET NOT NULL;

ALTER TABLE konektag.merchant_profiles
  DROP CONSTRAINT IF EXISTS merchant_profiles_beneficiary_type_check,
  ADD CONSTRAINT merchant_profiles_beneficiary_type_check
    CHECK (beneficiary_type IN ('NETWORK', 'MERCHANT'));

ALTER TABLE konektag.api_payment_webhook_deliveries
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

ALTER TABLE konektag.api_payment_webhook_deliveries
  ADD COLUMN IF NOT EXISTS processing_lease_id UUID;

ALTER TABLE konektag.api_payment_webhook_deliveries
  DROP CONSTRAINT IF EXISTS api_payment_webhook_deliveries_status_check;

ALTER TABLE konektag.api_payment_webhook_deliveries
  ADD CONSTRAINT api_payment_webhook_deliveries_status_check
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead_lettered'));

-- Legacy processing rows predate leases and would never be reclaimed as stale.
UPDATE konektag.api_payment_webhook_deliveries
SET status = 'failed',
    next_attempt_at = now(),
    processing_started_at = NULL,
    processing_lease_id = NULL,
    last_error = COALESCE(last_error, 'Webhook delivery recovered after lease migration'),
    updated_at = now()
WHERE status = 'processing'
  AND processing_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_payment_webhook_deliveries_due
  ON konektag.api_payment_webhook_deliveries(status, next_attempt_at, processing_started_at)
  WHERE status IN ('pending', 'failed', 'processing');

CREATE OR REPLACE FUNCTION konektag.prevent_beneficiary_type_change_with_open_api_payments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.beneficiary_type IS DISTINCT FROM OLD.beneficiary_type
     AND EXISTS (
       SELECT 1
       FROM konektag.api_payment_orders
       WHERE merchant_profile_id = OLD.id
         AND state IN ('pending', 'processing', 'awaiting_mobile_money')
     ) THEN
    RAISE EXCEPTION 'Cannot change beneficiary type while API payment orders are active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS merchant_profiles_prevent_beneficiary_type_change_with_open_api_payments
  ON konektag.merchant_profiles;

CREATE TRIGGER merchant_profiles_prevent_beneficiary_type_change_with_open_api_payments
BEFORE UPDATE OF beneficiary_type ON konektag.merchant_profiles
FOR EACH ROW
EXECUTE FUNCTION konektag.prevent_beneficiary_type_change_with_open_api_payments();
