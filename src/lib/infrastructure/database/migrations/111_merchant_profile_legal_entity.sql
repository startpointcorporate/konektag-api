BEGIN;

ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS legal_entity_id UUID REFERENCES konektag.legal_entities(id);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_legal_entity
  ON konektag.merchant_profiles(legal_entity_id) WHERE deleted_at IS NULL;

COMMIT;
