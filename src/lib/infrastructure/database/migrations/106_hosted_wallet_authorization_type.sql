BEGIN;

ALTER TABLE konektag.wallet_debit_authorizations
  DROP CONSTRAINT IF EXISTS wallet_debit_authorizations_operation_type_check;

ALTER TABLE konektag.wallet_debit_authorizations
  ADD CONSTRAINT wallet_debit_authorizations_operation_type_check CHECK (operation_type IN (
    'recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link', 'hosted_checkout'
  ));

COMMIT;
