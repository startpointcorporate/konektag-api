BEGIN;

ALTER TABLE konektag.core_transactions
  ADD COLUMN IF NOT EXISTS promotion_id UUID,
  ADD COLUMN IF NOT EXISTS promotion_fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS promotion_snapshot JSONB;

ALTER TABLE konektag.core_transactions
  ADD CONSTRAINT core_transactions_promotion_owner
  FOREIGN KEY (promotion_id)
  REFERENCES konektag.promotions(id)
  ON DELETE SET NULL;

ALTER TABLE konektag.core_transactions
  ADD CONSTRAINT core_transactions_promotion_snapshot_object
  CHECK (promotion_snapshot IS NULL OR jsonb_typeof(promotion_snapshot) = 'object');

COMMIT;
