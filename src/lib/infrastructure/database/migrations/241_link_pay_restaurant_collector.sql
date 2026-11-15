-- The execution site verifies the POS source; its explicit collector owns the API ledger collection.
-- Invoice links retain issuer=beneficiary. No beneficiary or commercial terms are inserted/changed.
BEGIN;
ALTER TABLE konektag.link_pay_network_links DROP CONSTRAINT link_pay_network_links_issuer_is_beneficiary;
ALTER TABLE konektag.link_pay_network_links ADD CONSTRAINT link_pay_network_links_issuer_is_beneficiary CHECK (
 issuer_site=beneficiary_site OR
 (collection_source_type='restaurant_order' AND collection_source IS NOT NULL
  AND collection_source ? 'collectorSite'
  AND COALESCE(collection_source->>'collectorSite','')=beneficiary_site
  AND COALESCE(length(collection_source->>'posProfile'),0)>0)
);
COMMIT;
