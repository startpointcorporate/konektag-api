CREATE TABLE IF NOT EXISTS konektag.merchant_offline_mutation_receipts (
  command_id UUID PRIMARY KEY,
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES konektag.users(id),
  object_type VARCHAR(20) NOT NULL CHECK (object_type IN ('account','profile','commerce','product','tax')),
  object_id UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_offline_mutation_receipts_profile
  ON konektag.merchant_offline_mutation_receipts(merchant_profile_id, created_at DESC);
