CREATE TABLE IF NOT EXISTS konektag.favorite_merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, merchant_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_favorite_merchants_user ON konektag.favorite_merchants(user_id);
