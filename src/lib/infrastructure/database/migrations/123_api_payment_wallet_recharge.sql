-- A Network wallet recharge is a payment request without a merchant counterparty.
BEGIN;

ALTER TABLE konektag.api_payment_orders
  ALTER COLUMN merchant_profile_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS order_purpose VARCHAR(30) NOT NULL DEFAULT 'merchant_payment',
  ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES konektag.users(id);

ALTER TABLE konektag.api_payment_orders
  DROP CONSTRAINT IF EXISTS ck_api_payment_orders_purpose_shape;

ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT ck_api_payment_orders_purpose_shape
  CHECK (
    (order_purpose = 'merchant_payment'
      AND merchant_profile_id IS NOT NULL
      AND target_user_id IS NULL)
    OR
    (order_purpose = 'wallet_recharge'
      AND merchant_profile_id IS NULL
      AND target_user_id IS NOT NULL
      AND beneficiary_type = 'NETWORK'
      AND beneficiary_party_id IS NULL)
  );

-- Keep merchant transaction idempotency explicit after merchant_profile_id became nullable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_payment_orders_merchant_transaction
  ON konektag.api_payment_orders(merchant_profile_id, merchant_transaction_id)
  WHERE merchant_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_wallet_recharge_target
  ON konektag.api_payment_orders(target_user_id, created_at DESC)
  WHERE order_purpose = 'wallet_recharge';

COMMIT;
