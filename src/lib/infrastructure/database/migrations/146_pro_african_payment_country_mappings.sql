-- Keep Pro payment links on the same country mapping authority as Checkout.
-- Existing active mappings take precedence, including any configured corridors.
BEGIN;

INSERT INTO konektag.payment_country_mappings (detected_country, payment_country, status, valid_from)
SELECT country, country, 'ACTIVE', CURRENT_DATE
FROM (VALUES ('CM'), ('TD'), ('CG'), ('CD'), ('GA'), ('GN'), ('GQ'), ('CF'), ('AO')) AS countries(country)
WHERE NOT EXISTS (
  SELECT 1 FROM konektag.payment_country_mappings existing
  WHERE existing.detected_country = countries.country
    AND existing.status = 'ACTIVE'
    AND existing.valid_from <= CURRENT_DATE
    AND (existing.valid_until IS NULL OR existing.valid_until >= CURRENT_DATE)
);

COMMIT;
