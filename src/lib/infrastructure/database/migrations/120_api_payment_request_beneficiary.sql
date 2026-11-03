-- An API payment order is the durable Payment Request. Freeze its beneficiary
-- before a provider session can be started so webhook settlement is deterministic.
BEGIN;

ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS beneficiary_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS beneficiary_party_id UUID REFERENCES konektag.parties(id);

ALTER TABLE konektag.api_payment_orders
  DROP CONSTRAINT IF EXISTS ck_api_payment_orders_beneficiary;

ALTER TABLE konektag.api_payment_orders
  ADD CONSTRAINT ck_api_payment_orders_beneficiary
  CHECK (
    beneficiary_type IS NULL
    OR (beneficiary_type = 'NETWORK' AND beneficiary_party_id IS NULL)
    OR (beneficiary_type = 'MERCHANT' AND beneficiary_party_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_beneficiary_party
  ON konektag.api_payment_orders(beneficiary_party_id)
  WHERE beneficiary_party_id IS NOT NULL;

COMMIT;
