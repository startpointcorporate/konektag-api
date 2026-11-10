-- After migration 230 (read-only). Every query states the expected result.
-- 1. Recorded once with the file checksum.            expected: 1 row, APPLIED
SELECT version, checksum, execution_status FROM konektag.schema_migrations WHERE filename = '230_link_pay_network_collections.sql';
-- 2. Tables, triggers and indexes present.             expected: 3 tables, 2 triggers, 3 indexes
SELECT to_regclass('konektag.link_pay_network_links'), to_regclass('konektag.link_pay_network_transactions'),
       to_regclass('konektag.link_pay_site_webhooks');
SELECT tgname FROM pg_trigger WHERE tgname IN ('link_pay_network_links_immutable', 'link_pay_network_transactions_immutable');
SELECT indexname FROM pg_indexes WHERE schemaname = 'konektag' AND indexname IN
  ('idx_link_pay_network_links_invoice', 'idx_link_pay_site_webhooks_due', 'idx_link_pay_site_webhooks_parent');
-- 3. Existing links untouched: same counts as precheck 2, none routed.   expected: identical, 0
SELECT source_type, status, (merchant_profile_id IS NOT NULL) AS merchant, (owner_user_id IS NOT NULL) AS owner, count(*)
  FROM konektag.checkout_intents GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;
SELECT count(*) AS routed FROM konektag.checkout_intents WHERE collection_route IS NOT NULL;
-- 4. Constraints validated on every existing row.       expected: both convalidated = true
SELECT conname, convalidated FROM pg_constraint
 WHERE conname IN ('checkout_intents_owner_check', 'checkout_intents_collection_route_check');
-- 5. Proof trigger: merchant branch kept, network branch added.  expected: true, true
SELECT position('points_merchant_consumptions' IN pg_get_functiondef('konektag.check_link_k_completion'::regproc)) > 0,
       position('link_pay_network_transactions' IN pg_get_functiondef('konektag.check_link_k_completion'::regproc)) > 0;
-- 6. Nothing collected yet.                             expected: 0, 0, 0
SELECT (SELECT count(*) FROM konektag.link_pay_network_links), (SELECT count(*) FROM konektag.link_pay_network_transactions),
       (SELECT count(*) FROM konektag.link_pay_site_webhooks);
