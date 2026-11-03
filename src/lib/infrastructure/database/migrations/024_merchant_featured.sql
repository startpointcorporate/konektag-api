ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS featured_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_featured ON konektag.merchant_profiles(featured DESC, featured_at DESC NULLS LAST);
