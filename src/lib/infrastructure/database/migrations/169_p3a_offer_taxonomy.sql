BEGIN;

CREATE TABLE konektag.offer_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) NOT NULL UNIQUE,
  activity_code VARCHAR(20) NOT NULL
    CHECK (activity_code IN ('Restaurant','Hotel','Commerce')),
  name_i18n JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_offer_categories_activity_active
  ON konektag.offer_categories(activity_code, is_active, sort_order)
  WHERE deleted_at IS NULL;

CREATE TABLE konektag.offer_subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL
    REFERENCES konektag.offer_categories(id) ON DELETE RESTRICT,
  code VARCHAR(100) NOT NULL,
  name_i18n JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(category_id, code)
);

CREATE INDEX idx_offer_subcategories_category_active
  ON konektag.offer_subcategories(category_id, is_active, sort_order)
  WHERE deleted_at IS NULL;

ALTER TABLE konektag.merchant_products
  ADD COLUMN offer_category_id UUID NOT NULL
    REFERENCES konektag.offer_categories(id) ON DELETE RESTRICT,
  ADD COLUMN offer_subcategory_id UUID
    REFERENCES konektag.offer_subcategories(id) ON DELETE RESTRICT;

CREATE INDEX idx_merchant_products_offer_category
  ON konektag.merchant_products(offer_category_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_merchant_products_offer_subcategory
  ON konektag.merchant_products(offer_subcategory_id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION konektag.validate_merchant_product_taxonomy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_activity_code TEXT;
  v_subcategory_category UUID;
  v_has_activity BOOLEAN;
BEGIN
  SELECT activity_code
    INTO v_activity_code
  FROM konektag.offer_categories
  WHERE id = NEW.offer_category_id
    AND deleted_at IS NULL
    AND is_active = true;

  IF v_activity_code IS NULL THEN
    RAISE EXCEPTION 'invalid offer_category_id';
  END IF;

  IF NEW.offer_subcategory_id IS NOT NULL THEN
    SELECT category_id
      INTO v_subcategory_category
    FROM konektag.offer_subcategories
    WHERE id = NEW.offer_subcategory_id
      AND deleted_at IS NULL
      AND is_active = true;

    IF v_subcategory_category IS DISTINCT FROM NEW.offer_category_id THEN
      RAISE EXCEPTION 'offer_subcategory_id does not belong to offer_category_id';
    END IF;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM konektag.%I
       WHERE merchant_profile_id = $1 AND deleted_at IS NULL
     )',
    CASE v_activity_code
      WHEN 'Restaurant' THEN 'restaurant_profiles'
      WHEN 'Hotel' THEN 'hotel_profiles'
      WHEN 'Commerce' THEN 'commerce_profiles'
    END
  )
  INTO v_has_activity
  USING NEW.merchant_profile_id;

  IF NOT v_has_activity THEN
    RAISE EXCEPTION 'merchant does not own activity % required by offer category', v_activity_code;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS merchant_product_taxonomy_guard
  ON konektag.merchant_products;

CREATE TRIGGER merchant_product_taxonomy_guard
BEFORE INSERT OR UPDATE OF offer_category_id, offer_subcategory_id, merchant_profile_id
ON konektag.merchant_products
FOR EACH ROW
EXECUTE FUNCTION konektag.validate_merchant_product_taxonomy();

-- P3-A2: the legacy parent search vector mixes activities and offers.
-- Marketplace search is now activity-scoped, so stop refreshing that global projection from Offers.
DROP TRIGGER IF EXISTS product_search_refresh ON konektag.merchant_products;

COMMIT;
