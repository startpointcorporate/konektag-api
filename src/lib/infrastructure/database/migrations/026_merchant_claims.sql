CREATE TABLE IF NOT EXISTS konektag.merchant_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  user_id UUID NOT NULL REFERENCES konektag.users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES konektag.users(id),
  UNIQUE(merchant_profile_id, user_id)
);

-- Index for listing pending claims
CREATE INDEX IF NOT EXISTS idx_merchant_claims_status ON konektag.merchant_claims(status);
CREATE INDEX IF NOT EXISTS idx_merchant_claims_user ON konektag.merchant_claims(user_id);
