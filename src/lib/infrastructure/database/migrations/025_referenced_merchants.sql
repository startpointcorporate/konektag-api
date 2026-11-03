ALTER TABLE konektag.merchant_profiles ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE konektag.merchant_profiles DROP CONSTRAINT IF EXISTS merchant_profiles_user_id_fkey;
ALTER TABLE konektag.merchant_profiles ADD CONSTRAINT merchant_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES konektag.users(id) ON DELETE SET NULL;

ALTER TABLE konektag.merchant_profiles DROP CONSTRAINT IF EXISTS merchant_profiles_status_check;
ALTER TABLE konektag.merchant_profiles ADD CONSTRAINT merchant_profiles_status_check CHECK (status::text = ANY (ARRAY['Draft'::character varying, 'Published'::character varying, 'Suspended'::character varying, 'Referenced'::character varying]::text[]));

ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT NULL;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS source_id VARCHAR(255) DEFAULT NULL;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS source_url TEXT DEFAULT NULL;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS referenced_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_source ON konektag.merchant_profiles(source);
