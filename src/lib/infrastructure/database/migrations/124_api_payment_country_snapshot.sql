-- Payment country is selected with the Payment Context and must survive provider retries.
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS payment_country VARCHAR(5);

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_payment_country
  ON konektag.api_payment_orders(payment_country)
  WHERE payment_country IS NOT NULL;
