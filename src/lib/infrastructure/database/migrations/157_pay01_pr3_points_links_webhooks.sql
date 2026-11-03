ALTER TABLE konektag.checkout_intents
  ADD COLUMN IF NOT EXISTS quantity_k BIGINT;

UPDATE konektag.checkout_intents
SET quantity_k = amount
WHERE source_type = 'payment_link' AND quantity_k IS NULL;

ALTER TABLE konektag.api_payment_webhook_deliveries
  DROP CONSTRAINT IF EXISTS api_payment_webhook_deliveries_event_type_check;

ALTER TABLE konektag.api_payment_webhook_deliveries
  ADD CONSTRAINT api_payment_webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'payment.succeeded',
    'payment.failed',
    'payment.cancelled',
    'payment.expired',
    'payment.refunded'
  ));
