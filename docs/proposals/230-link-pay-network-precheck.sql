-- Before migration 230 (read-only). Run on production with psql -X -v ON_ERROR_STOP=1.
-- 1. History: 229 applied, 230 not yet.
SELECT filename, execution_status FROM konektag.schema_migrations
 WHERE filename IN ('229_tenant_members.sql', '230_link_pay_network_collections.sql') ORDER BY filename;
-- 2. Existing links that must be preserved, by kind (kept unchanged by 230).
SELECT source_type, status, (merchant_profile_id IS NOT NULL) AS merchant, (owner_user_id IS NOT NULL) AS owner, count(*)
  FROM konektag.checkout_intents GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;
-- 3. Constraint replaced by 230 must be the expected one.
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'checkout_intents_owner_check';
-- expected: CHECK (((merchant_profile_id IS NOT NULL) <> (owner_user_id IS NOT NULL)))
-- 4. Proof trigger replaced by 230 must be the migration 200 one (md5 to compare with staging).
SELECT md5(pg_get_functiondef('konektag.check_link_k_completion'::regproc));
-- 5. Type of core_transaction_id (konektag-api#40/#41 wrote non-UUID keys into it).
SELECT data_type FROM information_schema.columns
 WHERE table_schema = 'konektag' AND table_name = 'checkout_intents' AND column_name = 'core_transaction_id';
-- 6. New objects must not exist yet.
SELECT to_regclass('konektag.link_pay_network_links'), to_regclass('konektag.link_pay_network_transactions'),
       to_regclass('konektag.link_pay_site_webhooks');
