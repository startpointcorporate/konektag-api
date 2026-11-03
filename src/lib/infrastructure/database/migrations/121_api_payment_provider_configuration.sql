-- Snapshot the non-secret logical provider credential selection for audit and retries.
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS provider_configuration_key VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_provider_configuration
  ON konektag.api_payment_orders(provider_configuration_key)
  WHERE provider_configuration_key IS NOT NULL;
