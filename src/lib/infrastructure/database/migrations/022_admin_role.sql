ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON konektag.users(role);

-- Promote the first user who completes onboarding to admin (safety valve)
-- or set manually: UPDATE konektag.users SET role = 'admin' WHERE email = 'admin@example.com';
