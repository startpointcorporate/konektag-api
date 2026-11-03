BEGIN;

ALTER TABLE konektag.hosted_checkouts
  ADD COLUMN IF NOT EXISTS public_token_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hosted_checkouts_public_token_hash
  ON konektag.hosted_checkouts(public_token_hash)
  WHERE public_token_hash IS NOT NULL;

ALTER TABLE konektag.api_payment_wallet_reservations
  ADD COLUMN IF NOT EXISTS hosted_payment_attempt_id UUID REFERENCES konektag.hosted_payment_attempts(id);

ALTER TABLE konektag.api_payment_wallet_reservations
  ALTER COLUMN payment_order_id DROP NOT NULL;

ALTER TABLE konektag.api_payment_wallet_reservations
  DROP CONSTRAINT IF EXISTS api_payment_wallet_reservations_payment_order_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_reservation_hosted_attempt
  ON konektag.api_payment_wallet_reservations(hosted_payment_attempt_id)
  WHERE hosted_payment_attempt_id IS NOT NULL;

ALTER TABLE konektag.api_payment_wallet_reservations
  ADD CONSTRAINT api_payment_wallet_reservation_parent_check
  CHECK ((payment_order_id IS NOT NULL)::integer + (hosted_payment_attempt_id IS NOT NULL)::integer = 1);

COMMIT;
