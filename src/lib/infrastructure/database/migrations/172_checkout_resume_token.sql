BEGIN;
ALTER TABLE konektag.api_payment_orders ADD COLUMN IF NOT EXISTS resume_token_hash VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_payment_orders_resume_token_hash ON konektag.api_payment_orders(resume_token_hash) WHERE resume_token_hash IS NOT NULL;
COMMIT;
