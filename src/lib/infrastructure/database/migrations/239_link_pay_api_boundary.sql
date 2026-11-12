-- API commercial reference; no inferred approval or fee defaults.
BEGIN;
CREATE TABLE konektag.link_pay_beneficiary_terms (
 network_site text NOT NULL CHECK(network_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
 beneficiary_site text NOT NULL CHECK(beneficiary_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
 beneficiary_name text NOT NULL CHECK(length(trim(beneficiary_name)) BETWEEN 1 AND 140),
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
 enabled boolean NOT NULL DEFAULT false, approved boolean NOT NULL DEFAULT false,
 approved_by text, approved_on timestamptz, terms_hash text,
 fee_mode text NOT NULL CHECK(fee_mode IN ('Percentage','Exempt')),
 fee_rate_bps integer NOT NULL CHECK(fee_rate_bps BETWEEN 0 AND 10000),
 payout_ready boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network_site,beneficiary_site),
 CHECK((fee_mode='Exempt' AND fee_rate_bps=0) OR (fee_mode='Percentage' AND fee_rate_bps>0)),
 CHECK(NOT approved OR (approved_by IS NOT NULL AND length(trim(approved_by))>0 AND approved_on IS NOT NULL AND terms_hash IS NOT NULL AND terms_hash ~ '^[a-f0-9]{64}$'))
);
COMMENT ON TABLE konektag.link_pay_beneficiary_terms IS 'API-owned Link Pay commercial reference. Import existing approved terms with original approval evidence, never infer from a paid link.';
ALTER TABLE konektag.link_pay_site_webhooks DROP CONSTRAINT link_pay_site_webhooks_status_check,
 ADD CONSTRAINT link_pay_site_webhooks_status_check CHECK(status IN ('blocked','pending','processing','delivered','failed','dead_lettered','cancelled'));
-- Preserve old delivery history; retire outstanding network-only ERP projections.
UPDATE konektag.link_pay_site_webhooks SET status='cancelled',next_attempt_at=NULL,
 processing_started_at=NULL,processing_lease_id=NULL,last_error='NETWORK_PROCESSING_OWNED_BY_API',updated_at=now()
 WHERE roles=ARRAY['network']::text[] AND status IN ('pending','failed','processing','blocked');
-- Only genuine completed ledger payments may release merchant integration.
UPDATE konektag.link_pay_site_webhooks w SET roles=ARRAY['beneficiary']::text[],
 payload=jsonb_set(w.payload,'{roles}','["beneficiary"]'::jsonb),depends_on=NULL,
 status=CASE WHEN w.status='blocked' THEN 'pending' ELSE w.status END,
 next_attempt_at=CASE WHEN w.status='blocked' THEN now() ELSE w.next_attempt_at END,updated_at=now()
 FROM konektag.link_pay_network_transactions t JOIN konektag.k_operations k ON k.id=t.k_operation_id
 WHERE w.transaction_id=t.id AND 'beneficiary'=ANY(w.roles) AND w.status<>'delivered'
  AND k.status='completed' AND w.target_site=t.beneficiary_site;
COMMIT;
