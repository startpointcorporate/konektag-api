BEGIN;

-- QR Pay / Link Pay merchant commission is a settlement-only commercial rule.
-- The payer never pays this commission. Checkout/internal is explicitly excluded.
CREATE TABLE konektag.merchant_payment_commission_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_country VARCHAR(5) NOT NULL CHECK(payment_country ~ '^[A-Z]{2,5}$'),
  rail TEXT NOT NULL CHECK(rail IN ('qr','payment_link')),
  percentage_bps INTEGER NOT NULL CHECK(percentage_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK(status IN ('DRAFT','APPROVED','REVOKED')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  approval_reference TEXT NOT NULL CHECK(length(btrim(approval_reference))>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE INDEX merchant_payment_commission_rule_lookup
 ON konektag.merchant_payment_commission_rules(payment_country,rail,status,valid_from,valid_until);

ALTER TABLE konektag.points_merchant_consumptions
 ADD COLUMN merchant_commission_rate_bps INTEGER CHECK(merchant_commission_rate_bps BETWEEN 0 AND 10000),
 ADD COLUMN merchant_commission_rule_id UUID REFERENCES konektag.merchant_payment_commission_rules(id),
 ADD COLUMN merchant_commission_amount_exact NUMERIC(24,8) CHECK(merchant_commission_amount_exact>=0),
 ADD CONSTRAINT merchant_commission_scope CHECK(
   (payment_rail IN ('qr','payment_link')
     AND merchant_commission_rate_bps IS NOT NULL
     AND merchant_commission_rule_id IS NOT NULL
     AND merchant_commission_amount_exact IS NOT NULL)
   OR
   (payment_rail NOT IN ('qr','payment_link')
     AND merchant_commission_rate_bps IS NULL
     AND merchant_commission_rule_id IS NULL
     AND merchant_commission_amount_exact IS NULL)
 );

-- Existing branch data is development-only; backfill approved QR/Link rows with an explicit 0% rule
-- only when needed so the new invariant is deterministic on upgraded test databases.
INSERT INTO konektag.merchant_payment_commission_rules(payment_country,rail,percentage_bps,status,approval_reference)
SELECT DISTINCT payment_country,payment_rail,0,'APPROVED','MIGRATION_182_ZERO_BASELINE'
FROM konektag.points_merchant_consumptions
WHERE payment_rail IN ('qr','payment_link') AND payment_country IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM konektag.merchant_payment_commission_rules r
    WHERE r.payment_country=points_merchant_consumptions.payment_country
      AND r.rail=points_merchant_consumptions.payment_rail AND r.status='APPROVED'
  );

UPDATE konektag.points_merchant_consumptions c
SET merchant_commission_rate_bps=rule.percentage_bps,
    merchant_commission_rule_id=rule.id,
    merchant_commission_amount_exact=c.transaction_amount_minor*rule.percentage_bps::numeric/10000
FROM konektag.merchant_payment_commission_rules rule
WHERE c.payment_rail IN ('qr','payment_link')
  AND c.merchant_commission_rule_id IS NULL
  AND rule.id = (
    SELECT r.id
    FROM konektag.merchant_payment_commission_rules r
    WHERE r.payment_country=c.payment_country
      AND r.rail=c.payment_rail
      AND r.status='APPROVED'
    ORDER BY r.valid_from DESC,r.id DESC
    LIMIT 1
  );

COMMIT;
