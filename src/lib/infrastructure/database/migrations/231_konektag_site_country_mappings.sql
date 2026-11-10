-- Migration 231 : every active rule must reach a Konektag entity with a Frappe site
-- (FR -> konektag-fr, CG -> konektag-cg, LB -> konektag-lb).
-- Before: LB had no rule; AO, CD, CF, CM, GA, GN, GQ, TD pointed to themselves,
-- where no Konektag site exists. They are now attached to CG.
-- Additive and replayable: old rows are kept as INACTIVE history.

BEGIN;

UPDATE konektag.payment_country_mappings
SET status = 'INACTIVE',
    valid_until = GREATEST(valid_from, CURRENT_DATE - 1)
WHERE status = 'ACTIVE'
  AND detected_country IN ('AO', 'CD', 'CF', 'CM', 'GA', 'GN', 'GQ', 'TD')
  AND payment_country <> 'CG';

INSERT INTO konektag.payment_country_mappings (detected_country, payment_country, status, valid_from)
SELECT mapping.detected_country, mapping.payment_country, 'ACTIVE', CURRENT_DATE
FROM (VALUES
  ('LB', 'LB'),
  ('AO', 'CG'), ('CD', 'CG'), ('CF', 'CG'), ('CM', 'CG'),
  ('GA', 'CG'), ('GN', 'CG'), ('GQ', 'CG'), ('TD', 'CG')
) AS mapping(detected_country, payment_country)
WHERE NOT EXISTS (
  SELECT 1 FROM konektag.payment_country_mappings existing
  WHERE existing.detected_country = mapping.detected_country
    AND existing.status = 'ACTIVE'
    AND (existing.valid_until IS NULL OR existing.valid_until >= CURRENT_DATE)
);

-- Fail the migration if any active rule still points outside FR, CG or LB.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM konektag.payment_country_mappings
    WHERE status = 'ACTIVE'
      AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
      AND payment_country NOT IN ('FR', 'CG', 'LB')
  ) THEN
    RAISE EXCEPTION 'payment_country_mappings: an active rule does not reach FR, CG or LB';
  END IF;
END $$;

COMMIT;
