-- Additive source metadata; invoice links retain their original defaults and behaviour.
BEGIN;
ALTER TABLE konektag.link_pay_network_links
 ADD COLUMN collection_source_type text NOT NULL DEFAULT 'invoice'
   CHECK(collection_source_type IN ('invoice','restaurant_order')),
 ADD COLUMN collection_source jsonb;
ALTER TABLE konektag.link_pay_network_links ADD CONSTRAINT link_pay_source_shape CHECK (
 (collection_source_type='invoice' AND collection_source IS NULL) OR
 (collection_source_type='restaurant_order' AND collection_source IS NOT NULL AND jsonb_typeof(collection_source)='object'
  AND collection_source ? 'attempt' AND collection_source ? 'posProfile'
  AND collection_source ? 'fingerprint'));
CREATE UNIQUE INDEX link_pay_restaurant_attempt_once
 ON konektag.link_pay_network_links(issuer_site,(collection_source->>'attempt'))
 WHERE collection_source_type='restaurant_order';
COMMIT;
