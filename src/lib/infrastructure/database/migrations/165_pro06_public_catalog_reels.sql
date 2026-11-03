BEGIN;
ALTER TABLE konektag.merchant_products ADD COLUMN IF NOT EXISTS catalog_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS pro06_media_merchant_identity ON konektag.merchant_media(id, merchant_profile_id);
CREATE TABLE IF NOT EXISTS konektag.merchant_reels (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
 article TEXT NOT NULL CHECK (length(article) BETWEEN 1 AND 20000),
 destination TEXT NOT NULL CHECK (destination IN ('profile','catalog','product')), product_id UUID,
 starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (starts_at < ends_at), CHECK ((destination='product') = (product_id IS NOT NULL)),
 FOREIGN KEY (product_id, merchant_profile_id) REFERENCES konektag.merchant_products(id,merchant_profile_id),
 UNIQUE(id,merchant_profile_id)
);
CREATE TABLE IF NOT EXISTS konektag.merchant_reel_media (
 reel_id UUID NOT NULL, merchant_profile_id UUID NOT NULL, media_id UUID NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(reel_id,media_id),
 FOREIGN KEY(reel_id,merchant_profile_id) REFERENCES konektag.merchant_reels(id,merchant_profile_id) ON DELETE CASCADE,
 FOREIGN KEY(media_id,merchant_profile_id) REFERENCES konektag.merchant_media(id,merchant_profile_id)
);
CREATE INDEX IF NOT EXISTS pro06_reels_period ON konektag.merchant_reels(merchant_profile_id,starts_at,ends_at);
CREATE UNIQUE INDEX IF NOT EXISTS pro06_catalog_checkout_transaction ON konektag.checkout_intents(core_transaction_id) WHERE core_transaction_id IS NOT NULL AND source_type='payment_link';
ALTER TABLE konektag.growth_destinations DROP CONSTRAINT IF EXISTS growth_destinations_target_type_check;
ALTER TABLE konektag.growth_destinations ADD CONSTRAINT growth_destinations_target_type_check CHECK (target_type IN ('profile','catalog','offer','promotion','checkout','campaign','content'));
COMMIT;
