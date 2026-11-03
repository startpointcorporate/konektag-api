-- Favorite public user profiles (USER_PROFILE)
CREATE TABLE IF NOT EXISTS konektag.favorite_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  favorite_user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, favorite_user_id)
);
CREATE INDEX IF NOT EXISTS idx_favorite_users_user_created ON konektag.favorite_users(user_id, created_at DESC);
