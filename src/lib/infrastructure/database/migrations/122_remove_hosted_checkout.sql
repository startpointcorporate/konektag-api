-- Retire le moteur Hosted Checkout abandonne sans effacer de donnees existantes.
-- Toute archive metier/comptable doit etre traitee avant cette migration.
DO $$
DECLARE
  has_hosted_data BOOLEAN;
  hosted_table TEXT;
BEGIN
  FOREACH hosted_table IN ARRAY ARRAY[
    'hosted_webhook_deliveries', 'provider_events', 'hosted_merchant_settlements',
    'hosted_payment_attempts', 'hosted_payment_allocations', 'hosted_payment_plans',
    'hosted_checkout_items', 'hosted_checkouts', 'hosted_checkout_settings'
  ] LOOP
    IF to_regclass(format('konektag.%I', hosted_table)) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM konektag.%I LIMIT 1)', hosted_table)
        INTO has_hosted_data;
      IF has_hosted_data THEN
        RAISE EXCEPTION 'Hosted Checkout data exists in %; archive it before schema removal', hosted_table;
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM konektag.outbox_events
    WHERE aggregate_type = 'HostedCheckout' OR event_type = 'HostedCheckoutMerchantWebhook'
  ) THEN
    RAISE EXCEPTION 'Hosted Checkout outbox events exist; process or archive them before schema removal';
  END IF;

  IF EXISTS (
    SELECT 1 FROM konektag.financial_transactions
    WHERE idempotency_key LIKE 'hosted-checkout-%'
  ) OR EXISTS (
    SELECT 1 FROM konektag.merchant_sales WHERE sale_ref LIKE 'HOSTED-%'
  ) THEN
    RAISE EXCEPTION 'Hosted Checkout financial history exists; retain it before schema removal';
  END IF;
END $$;

ALTER TABLE IF EXISTS konektag.api_payment_wallet_reservations
  DROP CONSTRAINT IF EXISTS api_payment_wallet_reservation_parent_check;
DROP INDEX IF EXISTS konektag.uq_wallet_reservation_hosted_attempt;
ALTER TABLE IF EXISTS konektag.api_payment_wallet_reservations
  DROP COLUMN IF EXISTS hosted_payment_attempt_id;
ALTER TABLE IF EXISTS konektag.api_payment_wallet_reservations
  ALTER COLUMN payment_order_id SET NOT NULL;

DO $$
BEGIN
  IF to_regclass('konektag.api_payment_wallet_reservations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'konektag.api_payment_wallet_reservations'::regclass
         AND conname = 'api_payment_wallet_reservations_payment_order_id_key'
     ) THEN
    ALTER TABLE konektag.api_payment_wallet_reservations
      ADD CONSTRAINT api_payment_wallet_reservations_payment_order_id_key UNIQUE (payment_order_id);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('konektag.wallet_debit_authorizations') IS NOT NULL THEN
    ALTER TABLE konektag.wallet_debit_authorizations
      DROP CONSTRAINT IF EXISTS wallet_debit_authorizations_operation_type_check;
    ALTER TABLE konektag.wallet_debit_authorizations
      ADD CONSTRAINT wallet_debit_authorizations_operation_type_check
      CHECK (operation_type IN ('recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link'));
  END IF;
END $$;

DROP TABLE IF EXISTS konektag.hosted_webhook_deliveries;
DROP TABLE IF EXISTS konektag.provider_events;
DROP TABLE IF EXISTS konektag.hosted_merchant_settlements;
DROP TABLE IF EXISTS konektag.hosted_payment_attempts;
DROP TABLE IF EXISTS konektag.hosted_payment_allocations;
DROP TABLE IF EXISTS konektag.hosted_payment_plans;
DROP TABLE IF EXISTS konektag.hosted_checkout_items;
DROP TABLE IF EXISTS konektag.hosted_checkouts;
DROP TABLE IF EXISTS konektag.hosted_checkout_settings;
