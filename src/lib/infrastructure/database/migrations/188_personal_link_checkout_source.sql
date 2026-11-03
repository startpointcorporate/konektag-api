BEGIN;
ALTER TABLE konektag.checkout_intents DROP CONSTRAINT IF EXISTS checkout_intents_source_type_check;
ALTER TABLE konektag.checkout_intents ADD CONSTRAINT checkout_intents_source_type_check
  CHECK (source_type IN ('qr','payment_link','personal_link'));
COMMIT;
