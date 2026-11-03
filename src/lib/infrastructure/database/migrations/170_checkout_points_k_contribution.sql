BEGIN;
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS wallet_contribution_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT api_payment_wallet_contribution_nonnegative CHECK (wallet_contribution_amount >= 0);
UPDATE konektag.api_payment_orders
SET wallet_contribution_amount = wallet_amount
WHERE wallet_contribution_amount = 0 AND wallet_amount > 0 AND currency = 'EUR';
COMMIT;
