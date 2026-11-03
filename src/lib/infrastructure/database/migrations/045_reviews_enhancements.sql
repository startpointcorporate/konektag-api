-- 045_reviews_enhancements.sql
-- Adds soft delete, versioning, and indexing to the reviews table.

ALTER TABLE konektag.reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_reviews_merchant
  ON konektag.reviews(merchant_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reviews_user_merchant
  ON konektag.reviews(user_id, merchant_id)
  WHERE deleted_at IS NULL;
