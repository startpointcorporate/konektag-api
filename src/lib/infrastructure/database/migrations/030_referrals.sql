CREATE TABLE IF NOT EXISTS konektag.referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(code)
);

CREATE TABLE IF NOT EXISTS konektag.referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES konektag.referral_codes(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  reward_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending', 'rewarded', 'expired')),
  reward_points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON konektag.referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_code ON konektag.referral_redemptions(code_id);
