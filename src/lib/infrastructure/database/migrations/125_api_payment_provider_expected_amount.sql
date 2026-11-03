ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS provider_expected_amount INTEGER;
