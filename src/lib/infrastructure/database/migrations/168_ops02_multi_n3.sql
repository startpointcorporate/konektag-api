-- OPS-02 / P1 — multi-N3 schema and marketplace read model
-- Parent: merchant_profiles. N3: restaurant_profiles, hotel_profiles, commerce_profiles.
BEGIN;

-- N3 overrides: NULL means "use merchant_profiles generic value".
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS long_description TEXT;
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(200);
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS long_description TEXT;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(200);
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS long_description TEXT;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(200);

-- N3 publication/feature state. Add nullable first so a replay never overwrites diverged N3 state.
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS status VARCHAR(20);
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS featured BOOLEAN;
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS status VARCHAR(20);
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS featured BOOLEAN;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS status VARCHAR(20);
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS featured BOOLEAN;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;

-- Preserve legacy physical capabilities at N3 level. Restaurant already owns delivery/take-away.
ALTER TABLE konektag.restaurant_profiles ADD COLUMN IF NOT EXISTS has_dine_in BOOLEAN;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS has_delivery BOOLEAN;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS has_takeout BOOLEAN;
ALTER TABLE konektag.hotel_profiles ADD COLUMN IF NOT EXISTS has_dine_in BOOLEAN;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS has_delivery BOOLEAN;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS has_takeout BOOLEAN;
ALTER TABLE konektag.commerce_profiles ADD COLUMN IF NOT EXISTS has_dine_in BOOLEAN;

-- Historical single-activity rows become the corresponding N3 if it does not already exist.
INSERT INTO konektag.restaurant_profiles (merchant_profile_id, has_delivery, has_take_away, has_dine_in)
SELECT mp.id, COALESCE(mp.has_delivery,false), COALESCE(mp.has_takeout,false), COALESCE(mp.has_dine_in,false)
FROM konektag.merchant_profiles mp
WHERE mp.activity_type = 'Restaurant'
ON CONFLICT (merchant_profile_id) DO NOTHING;

INSERT INTO konektag.hotel_profiles (merchant_profile_id, has_delivery, has_takeout, has_dine_in)
SELECT mp.id, COALESCE(mp.has_delivery,false), COALESCE(mp.has_takeout,false), COALESCE(mp.has_dine_in,false)
FROM konektag.merchant_profiles mp
WHERE mp.activity_type = 'Hotel'
ON CONFLICT (merchant_profile_id) DO NOTHING;

INSERT INTO konektag.commerce_profiles (merchant_profile_id, has_delivery, has_takeout, has_dine_in)
SELECT mp.id, COALESCE(mp.has_delivery,false), COALESCE(mp.has_takeout,false), COALESCE(mp.has_dine_in,false)
FROM konektag.merchant_profiles mp
WHERE mp.activity_type = 'Commerce'
ON CONFLICT (merchant_profile_id) DO NOTHING;

-- Backfill N3 state once. Existing explicit N3 values win on replay.
UPDATE konektag.restaurant_profiles rp SET
  status = COALESCE(rp.status, mp.status), featured = COALESCE(rp.featured, mp.featured),
  featured_at = COALESCE(rp.featured_at, mp.featured_at),
  has_dine_in = COALESCE(rp.has_dine_in, mp.has_dine_in)
FROM konektag.merchant_profiles mp WHERE mp.id = rp.merchant_profile_id;
UPDATE konektag.hotel_profiles hp SET
  status = COALESCE(hp.status, mp.status), featured = COALESCE(hp.featured, mp.featured),
  featured_at = COALESCE(hp.featured_at, mp.featured_at),
  has_delivery = COALESCE(hp.has_delivery, mp.has_delivery), has_takeout = COALESCE(hp.has_takeout, mp.has_takeout),
  has_dine_in = COALESCE(hp.has_dine_in, mp.has_dine_in)
FROM konektag.merchant_profiles mp WHERE mp.id = hp.merchant_profile_id;
UPDATE konektag.commerce_profiles cp SET
  status = COALESCE(cp.status, mp.status), featured = COALESCE(cp.featured, mp.featured),
  featured_at = COALESCE(cp.featured_at, mp.featured_at),
  has_delivery = COALESCE(cp.has_delivery, mp.has_delivery), has_takeout = COALESCE(cp.has_takeout, mp.has_takeout),
  has_dine_in = COALESCE(cp.has_dine_in, mp.has_dine_in)
FROM konektag.merchant_profiles mp WHERE mp.id = cp.merchant_profile_id;

ALTER TABLE konektag.restaurant_profiles ALTER COLUMN status SET DEFAULT 'Draft';
ALTER TABLE konektag.restaurant_profiles ALTER COLUMN status SET NOT NULL;
ALTER TABLE konektag.restaurant_profiles ALTER COLUMN featured SET DEFAULT false;
ALTER TABLE konektag.restaurant_profiles ALTER COLUMN featured SET NOT NULL;
ALTER TABLE konektag.hotel_profiles ALTER COLUMN status SET DEFAULT 'Draft';
ALTER TABLE konektag.hotel_profiles ALTER COLUMN status SET NOT NULL;
ALTER TABLE konektag.hotel_profiles ALTER COLUMN featured SET DEFAULT false;
ALTER TABLE konektag.hotel_profiles ALTER COLUMN featured SET NOT NULL;
ALTER TABLE konektag.commerce_profiles ALTER COLUMN status SET DEFAULT 'Draft';
ALTER TABLE konektag.commerce_profiles ALTER COLUMN status SET NOT NULL;
ALTER TABLE konektag.commerce_profiles ALTER COLUMN featured SET DEFAULT false;
ALTER TABLE konektag.commerce_profiles ALTER COLUMN featured SET NOT NULL;

-- Match the current merchant status vocabulary, including crawler-referenced merchants.
DO $$ BEGIN
  ALTER TABLE konektag.restaurant_profiles ADD CONSTRAINT restaurant_profiles_status_check CHECK (status IN ('Draft','Published','Suspended','Referenced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE konektag.hotel_profiles ADD CONSTRAINT hotel_profiles_status_check CHECK (status IN ('Draft','Published','Suspended','Referenced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE konektag.commerce_profiles ADD CONSTRAINT commerce_profiles_status_check CHECK (status IN ('Draft','Published','Suspended','Referenced'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Generic schedule = activity_code NULL. N3 schedule = one explicit activity code.
ALTER TABLE konektag.merchant_opening_hours ADD COLUMN IF NOT EXISTS activity_code VARCHAR(20);
DO $$ BEGIN
  ALTER TABLE konektag.merchant_opening_hours ADD CONSTRAINT merchant_opening_hours_activity_check
    CHECK (activity_code IS NULL OR activity_code IN ('Restaurant','Hotel','Commerce'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_hours_generic_day
  ON konektag.merchant_opening_hours(merchant_profile_id, day_of_week)
  WHERE activity_code IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_hours_activity_day
  ON konektag.merchant_opening_hours(merchant_profile_id, activity_code, day_of_week)
  WHERE activity_code IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_restaurant_profiles_status ON konektag.restaurant_profiles(status, featured DESC);
CREATE INDEX IF NOT EXISTS idx_hotel_profiles_status ON konektag.hotel_profiles(status, featured DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_profiles_status ON konektag.commerce_profiles(status, featured DESC);

-- category_id was a single-category compatibility projection of activity_type (migration 130).
-- Multi-N3 makes that parent-level projection invalid; N2/category mapping remains in merchant_categories.
DROP INDEX IF EXISTS konektag.idx_merchant_profiles_category;
ALTER TABLE konektag.merchant_profiles DROP COLUMN IF EXISTS category_id;

-- Marketplace read model: one row per N3, generic identity/location + resolved overridable values.
CREATE OR REPLACE VIEW konektag.marketplace_merchant_activities AS
SELECT mp.id AS merchant_profile_id, 'Restaurant'::varchar(20) AS activity_code,
       mp.business_name, mp.slug, mp.logo_url, mp.cover_image_url,
       COALESCE(rp.short_description, mp.short_description) AS short_description,
       COALESCE(rp.long_description, mp.long_description) AS long_description,
       COALESCE(rp.phone, mp.phone) AS phone, COALESCE(rp.email, mp.email) AS email,
       mp.address, mp.city, mp.country, mp.latitude, mp.longitude, mp.rating, mp.certification_status,
       rp.status, rp.featured, rp.featured_at,
       rp.has_delivery, rp.has_take_away AS has_takeout, rp.has_dine_in
FROM konektag.merchant_profiles mp JOIN konektag.restaurant_profiles rp ON rp.merchant_profile_id=mp.id
WHERE mp.deleted_at IS NULL AND rp.deleted_at IS NULL
UNION ALL
SELECT mp.id, 'Hotel'::varchar(20), mp.business_name, mp.slug, mp.logo_url, mp.cover_image_url,
       COALESCE(hp.short_description, mp.short_description), COALESCE(hp.long_description, mp.long_description),
       COALESCE(hp.phone, mp.phone), COALESCE(hp.email, mp.email),
       mp.address, mp.city, mp.country, mp.latitude, mp.longitude, mp.rating, mp.certification_status,
       hp.status, hp.featured, hp.featured_at, hp.has_delivery, hp.has_takeout, hp.has_dine_in
FROM konektag.merchant_profiles mp JOIN konektag.hotel_profiles hp ON hp.merchant_profile_id=mp.id
WHERE mp.deleted_at IS NULL AND hp.deleted_at IS NULL
UNION ALL
SELECT mp.id, 'Commerce'::varchar(20), mp.business_name, mp.slug, mp.logo_url, mp.cover_image_url,
       COALESCE(cp.short_description, mp.short_description), COALESCE(cp.long_description, mp.long_description),
       COALESCE(cp.phone, mp.phone), COALESCE(cp.email, mp.email),
       mp.address, mp.city, mp.country, mp.latitude, mp.longitude, mp.rating, mp.certification_status,
       cp.status, cp.featured, cp.featured_at, cp.has_delivery, cp.has_takeout, cp.has_dine_in
FROM konektag.merchant_profiles mp JOIN konektag.commerce_profiles cp ON cp.merchant_profile_id=mp.id
WHERE mp.deleted_at IS NULL AND cp.deleted_at IS NULL;

-- Remove the obsolete single-activity authority only after all backfills/read model creation.
DROP INDEX IF EXISTS konektag.idx_merchant_profiles_activity;
ALTER TABLE konektag.merchant_profiles DROP COLUMN IF EXISTS activity_type;

COMMIT;
