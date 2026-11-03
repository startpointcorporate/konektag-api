-- A restaurant can designate exactly one uploaded media as its current PDF/image menu.
ALTER TABLE konektag.restaurant_profiles
  ADD COLUMN IF NOT EXISTS menu_media_id UUID;

ALTER TABLE konektag.restaurant_profiles
  DROP CONSTRAINT IF EXISTS restaurant_profiles_menu_media_id_fkey;

ALTER TABLE konektag.restaurant_profiles
  ADD CONSTRAINT restaurant_profiles_menu_media_id_fkey
  FOREIGN KEY (menu_media_id) REFERENCES konektag.merchant_media(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_restaurant_profiles_menu_media
  ON konektag.restaurant_profiles(menu_media_id)
  WHERE menu_media_id IS NOT NULL;
