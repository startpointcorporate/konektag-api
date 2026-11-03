-- Separate restaurant offer structure from the medium used to present the menu.
ALTER TABLE konektag.restaurant_profiles
  ADD COLUMN IF NOT EXISTS offer_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS menu_medium VARCHAR(30),
  ADD COLUMN IF NOT EXISTS menu_external_url VARCHAR(500);

ALTER TABLE konektag.restaurant_profiles DROP CONSTRAINT IF EXISTS restaurant_profiles_offer_type_check;
ALTER TABLE konektag.restaurant_profiles ADD CONSTRAINT restaurant_profiles_offer_type_check
  CHECK (offer_type IS NULL OR offer_type IN ('AlaCarte','DailyMenu','SingleDish','Other'));

ALTER TABLE konektag.restaurant_profiles DROP CONSTRAINT IF EXISTS restaurant_profiles_menu_medium_check;
ALTER TABLE konektag.restaurant_profiles ADD CONSTRAINT restaurant_profiles_menu_medium_check
  CHECK (menu_medium IS NULL OR menu_medium IN ('Konektag','Pdf','Image','External','Board','None'));

-- Preserve existing data by mapping the legacy mixed menu_type values.
UPDATE konektag.restaurant_profiles SET
  offer_type = COALESCE(offer_type, CASE menu_type
    WHEN 'DailyMenu' THEN 'DailyMenu'
    WHEN 'SingleDish' THEN 'SingleDish'
    WHEN 'DigitalMenu' THEN 'AlaCarte'
    WHEN 'PdfMenu' THEN 'AlaCarte'
    WHEN 'ImageMenu' THEN 'AlaCarte'
    ELSE NULL END),
  menu_medium = COALESCE(menu_medium, CASE menu_type
    WHEN 'DigitalMenu' THEN 'Konektag'
    WHEN 'PdfMenu' THEN 'Pdf'
    WHEN 'ImageMenu' THEN 'Image'
    WHEN 'DailyMenu' THEN 'Board'
    WHEN 'SingleDish' THEN 'None'
    ELSE NULL END);
