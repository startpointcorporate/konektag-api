BEGIN;
-- A merchant-created order need not identify a customer. Preserve all historical customers.
ALTER TABLE konektag.core_transactions
  ADD COLUMN created_by_user_id UUID REFERENCES konektag.users(id),
  ALTER COLUMN customer_user_id DROP NOT NULL;
ALTER TABLE konektag.core_transactions ADD CONSTRAINT core_transaction_actor_required
  CHECK (customer_user_id IS NOT NULL OR created_by_user_id IS NOT NULL);
CREATE INDEX core_transactions_merchant_created ON konektag.core_transactions(merchant_profile_id, created_at DESC, id DESC);
ALTER TABLE konektag.notifications ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX notifications_event_recipient ON konektag.notifications(event_key, user_id);
COMMIT;
