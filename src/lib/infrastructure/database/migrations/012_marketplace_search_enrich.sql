-- Migration 012 : Enrichissement search_vector avec products_services et merchant_products.name
-- Version : 1.0 | Idempotent
-- Dépendance : 011_marketplace.sql

-- ═══ FONCTION : refresh_merchant_search_vector(profile_id UUID) ═══
CREATE OR REPLACE FUNCTION konektag.refresh_merchant_search_vector(profile_id UUID)
RETURNS void AS $$
DECLARE
    v_business_name TEXT;
    v_short_description TEXT;
    v_long_description TEXT;
    v_city TEXT;
    v_country TEXT;
    v_products_services TEXT;
    v_product_names TEXT;
    v_tsvector tsvector;
BEGIN
    SELECT mp.business_name, mp.short_description, mp.long_description,
           mp.city, mp.country, cp.products_services
    INTO v_business_name, v_short_description, v_long_description,
         v_city, v_country, v_products_services
    FROM konektag.merchant_profiles mp
    LEFT JOIN konektag.commerce_profiles cp ON cp.merchant_profile_id = mp.id AND cp.deleted_at IS NULL
    WHERE mp.id = refresh_merchant_search_vector.profile_id;

    SELECT string_agg(name, ' ')
    INTO v_product_names
    FROM konektag.merchant_products
    WHERE merchant_profile_id = refresh_merchant_search_vector.profile_id
      AND deleted_at IS NULL;

    v_tsvector :=
        setweight(to_tsvector('french', COALESCE(v_business_name, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE(v_short_description, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_city, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_country, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_products_services, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_product_names, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_long_description, '')), 'C');

    UPDATE konektag.merchant_profiles
    SET search_vector = v_tsvector
    WHERE id = refresh_merchant_search_vector.profile_id;
END;
$$ LANGUAGE plpgsql;

-- ═══ Remplace le trigger 011 : version BEFORE enrichie (products_services + product names) ═══
-- IMPORTANT : ne JAMAIS appeler refresh_merchant_search_vector() ici —
-- ce trigger BEFORE se déclenche sur INSERT/UPDATE de merchant_profiles,
-- et refresh fait un UPDATE sur cette même table → récursion infinie (stack depth).
CREATE OR REPLACE FUNCTION konektag.merchant_search_update() RETURNS TRIGGER AS $$
DECLARE
    v_products_services TEXT;
    v_product_names TEXT;
BEGIN
    SELECT cp.products_services INTO v_products_services
    FROM konektag.commerce_profiles cp
    WHERE cp.merchant_profile_id = NEW.id AND cp.deleted_at IS NULL;

    SELECT string_agg(name, ' ') INTO v_product_names
    FROM konektag.merchant_products
    WHERE merchant_profile_id = NEW.id AND deleted_at IS NULL;

    NEW.search_vector :=
        setweight(to_tsvector('french', COALESCE(NEW.business_name, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE(NEW.short_description, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.city, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.country, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_products_services, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_product_names, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.long_description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══ TRIGGER : commerce_profiles → rafraîchir le search_vector du profil parent ═══
CREATE OR REPLACE FUNCTION konektag.commerce_search_trigger() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM konektag.refresh_merchant_search_vector(OLD.merchant_profile_id);
    ELSE
        PERFORM konektag.refresh_merchant_search_vector(NEW.merchant_profile_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_search_refresh ON konektag.commerce_profiles;
CREATE TRIGGER commerce_search_refresh
    AFTER INSERT OR UPDATE OR DELETE ON konektag.commerce_profiles
    FOR EACH ROW EXECUTE FUNCTION konektag.commerce_search_trigger();

-- ═══ TRIGGER : merchant_products → rafraîchir le search_vector du profil parent ═══
CREATE OR REPLACE FUNCTION konektag.product_search_trigger() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM konektag.refresh_merchant_search_vector(OLD.merchant_profile_id);
    ELSE
        PERFORM konektag.refresh_merchant_search_vector(NEW.merchant_profile_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_search_refresh ON konektag.merchant_products;
CREATE TRIGGER product_search_refresh
    AFTER INSERT OR UPDATE OR DELETE ON konektag.merchant_products
    FOR EACH ROW EXECUTE FUNCTION konektag.product_search_trigger();

-- ═══ BACKFILL : recalculer tous les search_vector existants ═══
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM konektag.merchant_profiles WHERE deleted_at IS NULL
    LOOP
        PERFORM konektag.refresh_merchant_search_vector(r.id);
    END LOOP;
END $$;
