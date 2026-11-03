-- Migration 077 : P09 re-KYB date, P10 commissions auto, P07 commission ecriture

BEGIN;

-- P09 : date de prochaine revue KYB
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS kyb_next_review_date DATE;
ALTER TABLE konektag.merchant_profiles ADD COLUMN IF NOT EXISTS kyb_ubo_verified BOOLEAN DEFAULT false;

-- P07/P10 : tracking commissions
ALTER TABLE konektag.merchant_sales ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2);
ALTER TABLE konektag.merchant_sales ADD COLUMN IF NOT EXISTS settlement_id UUID;

COMMIT;
