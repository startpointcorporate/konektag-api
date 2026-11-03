-- Migration 127 : Structure des catégories de commerçants
-- Version : 1.0 | Idempotent

-- ═══ MERCHANT CATEGORIES ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name_i18n JSONB NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══ MERCHANT CATEGORY CAPABILITIES ═══
CREATE TABLE IF NOT EXISTS konektag.merchant_category_capabilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES konektag.merchant_categories(id) ON DELETE CASCADE,
    capability_key VARCHAR(50) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    configuration JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(category_id, capability_key)
);

-- ═══ MERCHANT PROFILES - Ajout de la colonne category_id ═══
ALTER TABLE konektag.merchant_profiles 
ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES konektag.merchant_categories(id);

-- ═══ INDEXES ═══
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_category ON konektag.merchant_profiles(category_id);
CREATE INDEX IF NOT EXISTS idx_merchant_category_capabilities_category ON konektag.merchant_category_capabilities(category_id);

-- ═══ SEED DES CATEGORIES DE COMPATIBILITÉ ═══

-- Création catégorie restaurant
INSERT INTO konektag.merchant_categories (code, name_i18n) 
VALUES ('restaurant', '{"fr": "Restaurant", "en": "Restaurant"}') 
ON CONFLICT (code) DO NOTHING
RETURNING id AS restaurant_category_id;

-- Création catégorie hotel  
INSERT INTO konektag.merchant_categories (code, name_i18n) 
VALUES ('hotel', '{"fr": "Hôtel", "en": "Hotel"}') 
ON CONFLICT (code) DO NOTHING
RETURNING id AS hotel_category_id;

-- Création catégorie commerce
INSERT INTO konektag.merchant_categories (code, name_i18n) 
VALUES ('commerce', '{"fr": "Commerce", "en": "Shop"}') 
ON CONFLICT (code) DO NOTHING
RETURNING id AS commerce_category_id;

-- ═══ SEED DES CAPACITÉS BASÉES SUR L'EXISTANT ═══

-- Capacités pour restaurant : booking activé
INSERT INTO konektag.merchant_category_capabilities (category_id, capability_key, is_enabled, configuration)
VALUES (
    (SELECT id FROM konektag.merchant_categories WHERE code = 'restaurant'),
    'booking',
    true,
    '{}'
)
ON CONFLICT (category_id, capability_key) DO NOTHING;

-- Capacités pour hotel : booking activé  
INSERT INTO konektag.merchant_category_capabilities (category_id, capability_key, is_enabled, configuration)
VALUES (
    (SELECT id FROM konektag.merchant_categories WHERE code = 'hotel'),
    'booking',
    true,
    '{}'
)
ON CONFLICT (category_id, capability_key) DO NOTHING;

-- Capacités pour commerce : catalog activé
INSERT INTO konektag.merchant_category_capabilities (category_id, capability_key, is_enabled, configuration)
VALUES (
    (SELECT id FROM konektag.merchant_categories WHERE code = 'commerce'),
    'catalog',
    true,
    '{}'
)
ON CONFLICT (category_id, capability_key) DO NOTHING;

-- ═══ BACKFILL ACTIVITY_TYPE → CATEGORY_ID ═══

-- Backfill pour les profiles existants sans catégorie
UPDATE konektag.merchant_profiles mp
SET category_id = (
    CASE 
        WHEN mp.activity_type = 'Restaurant' THEN (SELECT id FROM konektag.merchant_categories WHERE code = 'restaurant')
        WHEN mp.activity_type = 'Hotel' THEN (SELECT id FROM konektag.merchant_categories WHERE code = 'hotel')
        WHEN mp.activity_type = 'Commerce' THEN (SELECT id FROM konektag.merchant_categories WHERE code = 'commerce')
        ELSE NULL
    END
)
WHERE mp.category_id IS NULL 
AND mp.activity_type IN ('Restaurant', 'Hotel', 'Commerce');