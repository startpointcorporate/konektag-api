BEGIN;
ALTER TABLE konektag.api_payment_orders ADD COLUMN IF NOT EXISTS amount_unit VARCHAR(5) NOT NULL DEFAULT 'MAJOR';
ALTER TABLE konektag.api_payment_orders ADD CONSTRAINT api_payment_amount_unit_check CHECK (amount_unit IN ('MAJOR', 'MINOR'));
COMMIT;