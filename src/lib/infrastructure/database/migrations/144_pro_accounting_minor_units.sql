BEGIN;
ALTER TABLE konektag.financial_transactions
  ADD COLUMN amount_unit VARCHAR(5) NOT NULL DEFAULT 'MAJOR';
ALTER TABLE konektag.financial_transactions
  ADD CONSTRAINT chk_amount_unit_major_minor_ft
  CHECK (amount_unit IN ('MAJOR','MINOR'));

ALTER TABLE konektag.ledger_entries
  ADD COLUMN amount_unit VARCHAR(5) NOT NULL DEFAULT 'MAJOR';
ALTER TABLE konektag.ledger_entries
  ADD CONSTRAINT chk_amount_unit_major_minor_le
  CHECK (amount_unit IN ('MAJOR','MINOR'));

ALTER TABLE konektag.merchant_sales
  ADD COLUMN amount_unit VARCHAR(5) NOT NULL DEFAULT 'MAJOR';
ALTER TABLE konektag.merchant_sales
  ADD CONSTRAINT chk_amount_unit_major_minor_ms
  CHECK (amount_unit IN ('MAJOR','MINOR'));
COMMIT;