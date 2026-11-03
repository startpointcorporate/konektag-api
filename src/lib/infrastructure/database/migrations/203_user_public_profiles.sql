-- Public user profile fields used by USER_PROFILE and marketplace discovery.
CREATE TABLE IF NOT EXISTS konektag.user_public_profiles (
  user_id UUID PRIMARY KEY REFERENCES konektag.users(id) ON DELETE CASCADE,
  title VARCHAR(160), description TEXT,
  country VARCHAR(100), city VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_public_profiles_marketplace ON konektag.user_public_profiles(country,city) WHERE status='published';
