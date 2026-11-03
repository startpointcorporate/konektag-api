-- P3-C2 — one source of truth for public external URLs: merchant_external_links.
BEGIN;
ALTER TABLE konektag.restaurant_profiles DROP COLUMN IF EXISTS menu_url;
ALTER TABLE konektag.hotel_profiles DROP COLUMN IF EXISTS booking_url;
ALTER TABLE konektag.commerce_profiles DROP COLUMN IF EXISTS catalog_url;
COMMIT;
