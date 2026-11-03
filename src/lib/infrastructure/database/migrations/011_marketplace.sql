-- Migration 011 : Module Marketplace — Profils commerçants
-- Version : 1.0 | Idempotent

-- ═══ MERCHANT PROFILES ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_profiles (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES konektag.users(id),
    business_name     VARCHAR(200) NOT NULL,
    slug              VARCHAR(250) NOT NULL UNIQUE,
    activity_type     VARCHAR(20) NOT NULL
                      CHECK (activity_type IN ('Restaurant', 'Hotel', 'Commerce')),
    logo_url          VARCHAR(500),
    cover_image_url   VARCHAR(500),
    short_description TEXT,
    long_description  TEXT,
    address           VARCHAR(300),
    city              VARCHAR(100),
    country           VARCHAR(100),
    phone             VARCHAR(30),
    email             VARCHAR(200),
    website_url       VARCHAR(500),
    external_links    JSONB NOT NULL DEFAULT '[]',
    opening_hours     JSONB NOT NULL DEFAULT '[]',
    status            VARCHAR(20) NOT NULL DEFAULT 'Draft'
                      CHECK (status IN ('Draft', 'Published', 'Suspended')),
    qr_code_url       VARCHAR(500),
    public_page_url   VARCHAR(500),
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMP WITH TIME ZONE,
    version           INTEGER NOT NULL DEFAULT 1,
    created_by        UUID,
    updated_by        UUID
);

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_user ON konektag.merchant_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_slug ON konektag.merchant_profiles(slug);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_status ON konektag.merchant_profiles(status);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_activity ON konektag.merchant_profiles(activity_type);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_city ON konektag.merchant_profiles(city);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_country ON konektag.merchant_profiles(country);

-- Full-text search index
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_search ON konektag.merchant_profiles USING GIN (search_vector);

CREATE OR REPLACE FUNCTION konektag.merchant_search_update() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('french', COALESCE(NEW.business_name, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE(NEW.short_description, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.long_description, '')), 'C') ||
        setweight(to_tsvector('french', COALESCE(NEW.city, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.country, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchant_search_trigger ON konektag.merchant_profiles;
CREATE TRIGGER merchant_search_trigger
    BEFORE INSERT OR UPDATE ON konektag.merchant_profiles
    FOR EACH ROW EXECUTE FUNCTION konektag.merchant_search_update();

-- ═══ MERCHANT MEDIA ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_media (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    media_type          VARCHAR(10) NOT NULL
                        CHECK (media_type IN ('Image', 'Pdf', 'Audio', 'Video')),
    title               VARCHAR(200),
    description         TEXT,
    file_url            VARCHAR(500) NOT NULL,
    thumbnail_url       VARCHAR(500),
    display_order       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_merchant_media_profile ON konektag.merchant_media(merchant_profile_id);

-- ═══ MERCHANT EXTERNAL LINKS ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_external_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    label               VARCHAR(100) NOT NULL,
    url                 VARCHAR(500) NOT NULL,
    link_type           VARCHAR(20) NOT NULL DEFAULT 'Website'
                        CHECK (link_type IN ('Website', 'Instagram', 'Facebook', 'TikTok', 'YouTube', 'Booking', 'Menu', 'Other')),
    display_order       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_merchant_links_profile ON konektag.merchant_external_links(merchant_profile_id);

-- ═══ MERCHANT OPENING HOURS ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_opening_hours (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    day_of_week         INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    open_time           TIME,
    close_time          TIME,
    is_closed           BOOLEAN NOT NULL DEFAULT false,
    break_start_time    TIME,
    break_end_time      TIME,
    open_time_2         TIME,
    close_time_2        TIME,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_merchant_hours_profile ON konektag.merchant_opening_hours(merchant_profile_id);

-- ═══ RESTAURANT PROFILES ═══
CREATE TABLE IF NOT EXISTS konektag.restaurant_profiles (
    merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    price_range         VARCHAR(10)
                        CHECK (price_range IN ('Low', 'Medium', 'High', 'Premium')),
    cuisine_types       JSONB NOT NULL DEFAULT '[]',
    has_menu            BOOLEAN NOT NULL DEFAULT false,
    menu_type           VARCHAR(20)
                        CHECK (menu_type IS NULL OR menu_type IN ('DigitalMenu', 'PdfMenu', 'ImageMenu', 'SingleDish', 'DailyMenu')),
    menu_url            VARCHAR(500),
    specialties         TEXT,
    average_meal_price  DECIMAL(10,2),
    has_delivery        BOOLEAN NOT NULL DEFAULT false,
    has_take_away       BOOLEAN NOT NULL DEFAULT false,
    has_reservation     BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

-- ═══ HOTEL PROFILES ═══
CREATE TABLE IF NOT EXISTS konektag.hotel_profiles (
    merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    price_range         VARCHAR(10)
                        CHECK (price_range IN ('Low', 'Medium', 'High', 'Premium')),
    stars               INTEGER CHECK (stars IS NULL OR stars BETWEEN 1 AND 5),
    room_price_min      DECIMAL(10,2),
    room_price_max      DECIMAL(10,2),
    amenities           JSONB NOT NULL DEFAULT '[]',
    check_in_time       TIME,
    check_out_time      TIME,
    has_online_booking  BOOLEAN NOT NULL DEFAULT false,
    booking_url         VARCHAR(500),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

-- ═══ COMMERCE PROFILES ═══
CREATE TABLE IF NOT EXISTS konektag.commerce_profiles (
    merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    main_activity       VARCHAR(20)
                        CHECK (main_activity IN ('Alimentation', 'Mode', 'Beauté', 'Électronique', 'Services', 'Artisanat', 'Santé', 'Autre')),
    price_range         VARCHAR(10)
                        CHECK (price_range IN ('Low', 'Medium', 'High', 'Premium')),
    products_services   TEXT,
    has_catalog         BOOLEAN NOT NULL DEFAULT false,
    catalog_url         VARCHAR(500),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

-- ═══ MERCHANT PRODUCTS / SERVICES ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    name                VARCHAR(200) NOT NULL,
    description         TEXT,
    price               DECIMAL(10,2),
    currency            VARCHAR(5) NOT NULL DEFAULT 'XOF',
    image_url           VARCHAR(500),
    category            VARCHAR(100),
    display_order       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMP WITH TIME ZONE,
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_profile ON konektag.merchant_products(merchant_profile_id);

-- ═══ MERCHANT SLUG HISTORY (redirections 301 lors de changement de slug) ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_slug_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    old_slug            VARCHAR(250) NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_slug_history_old ON konektag.merchant_slug_history(old_slug);

-- ═══ TRIGGERS updated_at ═══
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'konektag'
          AND tablename IN (
              'merchant_profiles','merchant_media','merchant_external_links',
              'merchant_opening_hours','restaurant_profiles','hotel_profiles',
              'commerce_profiles','merchant_products'
          )
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I_updated_at ON konektag.%I;
             CREATE TRIGGER %I_updated_at BEFORE UPDATE ON konektag.%I
             FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at()',
            t, t, t, t
        );
    END LOOP;
END $$;

-- ═══ FEATURE my_business ═══
INSERT INTO konektag.features (feature_key, name_i18n, icon, sort_order, is_required) VALUES
    ('my_business', '{"fr":"Mon commerce","en":"My business","ar":"عملي","pt":"Meu negócio","es":"Mi negocio","sw":"Biashara yangu","ha":"Kasuwanci na","yo":"Iṣowo mi","zh":"我的生意","hi":"मेरा व्यवसाय"}',
     'store', 12, false)
ON CONFLICT (feature_key) DO UPDATE SET
    name_i18n = EXCLUDED.name_i18n,
    icon = EXCLUDED.icon,
    sort_order = EXCLUDED.sort_order,
    is_required = EXCLUDED.is_required;
