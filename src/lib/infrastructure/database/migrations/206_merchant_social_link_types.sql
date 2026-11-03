-- Extend merchant external links with the main social networks used by businesses.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'konektag' AND rel.relname = 'merchant_external_links'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%link_type%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE konektag.merchant_external_links DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
ALTER TABLE konektag.merchant_external_links
  ADD CONSTRAINT merchant_external_links_link_type_check
  CHECK (link_type IN ('Website','Instagram','Facebook','TikTok','YouTube','LinkedIn','Pinterest','X','Threads','Snapchat','WhatsApp','Telegram','Booking','Menu','Catalog','Other'));
