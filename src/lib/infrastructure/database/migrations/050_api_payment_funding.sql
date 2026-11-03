-- Persist the server-calculated Wallet/external split for API checkouts.
-- Existing orders retain their previous all-external behavior.
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS wallet_available_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS external_amount INTEGER,
  ADD COLUMN IF NOT EXISTS payer_party_id UUID REFERENCES konektag.parties(id),
  ADD COLUMN IF NOT EXISTS funding_state VARCHAR(30) NOT NULL DEFAULT 'unprepared';

UPDATE konektag.api_payment_orders
SET external_amount = total_amount
WHERE external_amount IS NULL;

ALTER TABLE konektag.api_payment_orders
  ALTER COLUMN external_amount SET NOT NULL;

UPDATE konektag.api_payment_orders
SET funding_state = CASE
  WHEN state = 'paid' THEN 'finalized'
  WHEN state IN ('processing', 'awaiting_mobile_money')
       AND payment_method IN ('card', 'mobile_money') THEN 'external_started'
  ELSE funding_state
END
WHERE funding_state = 'unprepared';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_api_payment_orders_funding_amounts'
  ) THEN
    ALTER TABLE konektag.api_payment_orders
      ADD CONSTRAINT ck_api_payment_orders_funding_amounts
      CHECK (
        wallet_available_amount >= 0
        AND wallet_amount >= 0
        AND external_amount >= 0
        AND wallet_amount <= wallet_available_amount
        AND wallet_amount + external_amount = total_amount
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_api_payment_orders_funding_state'
  ) THEN
    ALTER TABLE konektag.api_payment_orders
      ADD CONSTRAINT ck_api_payment_orders_funding_state
      CHECK (funding_state IN ('unprepared', 'prepared', 'external_started', 'finalized'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_payer_party
  ON konektag.api_payment_orders(payer_party_id)
  WHERE payer_party_id IS NOT NULL;
