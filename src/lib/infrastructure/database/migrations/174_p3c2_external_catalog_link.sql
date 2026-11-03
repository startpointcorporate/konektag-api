-- P3-C2 — external Commerce catalogue links are first-class Marketplace links.
BEGIN;
ALTER TABLE konektag.merchant_external_links DROP CONSTRAINT IF EXISTS merchant_external_links_link_type_check;
ALTER TABLE konektag.merchant_external_links
  ADD CONSTRAINT merchant_external_links_link_type_check
  CHECK (link_type IN ('Website','Instagram','Facebook','TikTok','YouTube','Booking','Menu','Catalog','Other'));
COMMIT;
