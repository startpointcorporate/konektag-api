-- Migration 167 : PRO-06 Marketplace catalog search vector
-- Enrichit le search_vector marchand avec le catalogue public.
-- Les Offers privées, draft, archivées ou supprimées sont exclues.
-- Idempotent.

CREATE OR REPLACE FUNCTION konektag.refresh_merchant_search_vector(profile_id UUID)
RETURNS void AS $$
DECLARE
    v_business_name TEXT;
    v_short_description TEXT;
    v_long_description TEXT;
    v_city TEXT;
    v_country TEXT;
    v_products_services TEXT;
    v_catalog_search TEXT;
    v_tsvector tsvector;
BEGIN
    SELECT
        mp.business_name,
        mp.short_description,
        mp.long_description,
        mp.city,
        mp.country,
        cp.products_services
    INTO
        v_business_name,
        v_short_description,
        v_long_description,
        v_city,
        v_country,
        v_products_services
    FROM konektag.merchant_profiles mp
    LEFT JOIN konektag.commerce_profiles cp
        ON cp.merchant_profile_id = mp.id
       AND cp.deleted_at IS NULL
    WHERE mp.id = refresh_merchant_search_vector.profile_id;

    SELECT string_agg(
        concat_ws(
            ' ',
            p.name,
            p.category,
            p.description,
            p.catalog_metadata->>'subcategory',
            p.catalog_metadata->>'shortDescription',
            p.catalog_metadata->>'detailedDescription',
            CASE
                WHEN jsonb_typeof(p.catalog_metadata->'tags') = 'array'
                THEN (
                    SELECT string_agg(tag.value, ' ')
                    FROM jsonb_array_elements_text(p.catalog_metadata->'tags') AS tag(value)
                )
                ELSE ''
            END
        ),
        ' '
    )
    INTO v_catalog_search
    FROM konektag.merchant_products p
    WHERE p.merchant_profile_id = refresh_merchant_search_vector.profile_id
      AND p.deleted_at IS NULL
      AND COALESCE(p.catalog_metadata->>'status', 'active') = 'active'
      AND COALESCE(p.catalog_metadata->>'visibility', 'public') = 'public';

    v_tsvector :=
        setweight(to_tsvector('french', COALESCE(v_business_name, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE(v_short_description, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_city, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_country, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_products_services, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_catalog_search, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_long_description, '')), 'C');

    UPDATE konektag.merchant_profiles
    SET search_vector = v_tsvector
    WHERE id = refresh_merchant_search_vector.profile_id;
END;
$$ LANGUAGE plpgsql;


-- Le BEFORE trigger merchant_profiles doit appliquer exactement
-- les mêmes règles d'agrégation catalogue.
CREATE OR REPLACE FUNCTION konektag.merchant_search_update()
RETURNS TRIGGER AS $$
DECLARE
    v_products_services TEXT;
    v_catalog_search TEXT;
BEGIN
    SELECT cp.products_services
    INTO v_products_services
    FROM konektag.commerce_profiles cp
    WHERE cp.merchant_profile_id = NEW.id
      AND cp.deleted_at IS NULL;

    SELECT string_agg(
        concat_ws(
            ' ',
            p.name,
            p.category,
            p.description,
            p.catalog_metadata->>'subcategory',
            p.catalog_metadata->>'shortDescription',
            p.catalog_metadata->>'detailedDescription',
            CASE
                WHEN jsonb_typeof(p.catalog_metadata->'tags') = 'array'
                THEN (
                    SELECT string_agg(tag.value, ' ')
                    FROM jsonb_array_elements_text(p.catalog_metadata->'tags') AS tag(value)
                )
                ELSE ''
            END
        ),
        ' '
    )
    INTO v_catalog_search
    FROM konektag.merchant_products p
    WHERE p.merchant_profile_id = NEW.id
      AND p.deleted_at IS NULL
      AND COALESCE(p.catalog_metadata->>'status', 'active') = 'active'
      AND COALESCE(p.catalog_metadata->>'visibility', 'public') = 'public';

    NEW.search_vector :=
        setweight(to_tsvector('french', COALESCE(NEW.business_name, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE(NEW.short_description, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.city, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.country, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_products_services, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(v_catalog_search, '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(NEW.long_description, '')), 'C');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Le trigger product_search_refresh de la migration 012 reste valide :
-- tout INSERT / UPDATE / DELETE d'une Offer recalcule le vecteur parent.


-- Garantit la présence de l'index GIN existant sans en créer un second.
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_search
ON konektag.merchant_profiles
USING GIN (search_vector);


-- Backfill de tous les profils actifs avec les nouvelles règles.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT id
        FROM konektag.merchant_profiles
        WHERE deleted_at IS NULL
    LOOP
        PERFORM konektag.refresh_merchant_search_vector(r.id);
    END LOOP;
END $$;
