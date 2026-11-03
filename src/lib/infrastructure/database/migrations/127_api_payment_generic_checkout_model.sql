BEGIN;

ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS business_purpose VARCHAR(64) NOT NULL DEFAULT 'merchant_payment',
  ADD COLUMN IF NOT EXISTS execution_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS redirect_success_url TEXT,
  ADD COLUMN IF NOT EXISTS redirect_cancel_url TEXT,
  ADD COLUMN IF NOT EXISTS redirect_pending_url TEXT,
  ADD COLUMN IF NOT EXISTS order_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE konektag.api_payment_orders
  DROP CONSTRAINT IF EXISTS api_payment_orders_state_check,
  DROP CONSTRAINT IF EXISTS ck_api_payment_orders_state;

ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT ck_api_payment_orders_state
  CHECK (state IN ('pending', 'processing', 'awaiting_mobile_money', 'paid', 'failed', 'expired', 'cancelled'));

ALTER TABLE konektag.api_payment_orders
  DROP CONSTRAINT IF EXISTS ck_api_payment_orders_line_items_array;

ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT ck_api_payment_orders_line_items_array
  CHECK (jsonb_typeof(line_items) = 'array');

ALTER TABLE konektag.api_payment_orders
  DROP CONSTRAINT IF EXISTS ck_api_payment_orders_metadata_object;

ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT ck_api_payment_orders_metadata_object
  CHECK (jsonb_typeof(order_metadata) = 'object');

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_business_purpose
  ON konektag.api_payment_orders(business_purpose, created_at DESC);

COMMIT;
