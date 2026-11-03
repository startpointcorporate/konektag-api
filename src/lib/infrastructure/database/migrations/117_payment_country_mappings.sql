-- Migration 117 : routage du pays detecte vers le pays du pipeline Payment

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS konektag.payment_country_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_country VARCHAR(2) NOT NULL CHECK (detected_country = upper(detected_country) AND detected_country ~ '^[A-Z]{2}$'),
  payment_country VARCHAR(2) NOT NULL CHECK (payment_country = upper(payment_country) AND payment_country ~ '^[A-Z]{2}$'),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  valid_from DATE NOT NULL,
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

ALTER TABLE konektag.payment_country_mappings
  ADD CONSTRAINT payment_country_mappings_no_active_overlap
  EXCLUDE USING gist (
    detected_country WITH =,
    daterange(valid_from, COALESCE(valid_until, 'infinity'::date), '[]') WITH &&
  ) WHERE (status = 'ACTIVE');

CREATE INDEX IF NOT EXISTS idx_payment_country_mappings_lookup
  ON konektag.payment_country_mappings(detected_country, valid_from, valid_until)
  WHERE status = 'ACTIVE';

CREATE TRIGGER payment_country_mappings_updated_at
  BEFORE UPDATE ON konektag.payment_country_mappings
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();

INSERT INTO konektag.payment_country_mappings (detected_country, payment_country, status, valid_from)
SELECT mapping.detected_country, mapping.payment_country, 'ACTIVE', CURRENT_DATE
FROM (VALUES ('FR', 'FR'), ('BE', 'FR'), ('LU', 'FR')) AS mapping(detected_country, payment_country)
WHERE NOT EXISTS (
  SELECT 1 FROM konektag.payment_country_mappings existing
  WHERE existing.detected_country = mapping.detected_country
    AND existing.payment_country = mapping.payment_country
    AND existing.status = 'ACTIVE'
    AND existing.valid_from <= CURRENT_DATE
    AND (existing.valid_until IS NULL OR existing.valid_until >= CURRENT_DATE)
);

COMMIT;
