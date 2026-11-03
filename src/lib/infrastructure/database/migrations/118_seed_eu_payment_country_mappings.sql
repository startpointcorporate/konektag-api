-- Migration 118 : tous les Etats membres de l'Union europeenne utilisent le pipeline Payment France

BEGIN;

INSERT INTO konektag.payment_country_mappings (detected_country, payment_country, status, valid_from)
SELECT mapping.detected_country, 'FR', 'ACTIVE', CURRENT_DATE
FROM (VALUES
  ('AT'), ('BE'), ('BG'), ('HR'), ('CY'), ('CZ'), ('DK'), ('EE'), ('FI'), ('FR'),
  ('DE'), ('GR'), ('HU'), ('IE'), ('IT'), ('LV'), ('LT'), ('LU'), ('MT'), ('NL'),
  ('PL'), ('PT'), ('RO'), ('SK'), ('SI'), ('ES'), ('SE')
) AS mapping(detected_country)
WHERE NOT EXISTS (
  SELECT 1 FROM konektag.payment_country_mappings existing
  WHERE existing.detected_country = mapping.detected_country
    AND existing.status = 'ACTIVE'
    AND existing.valid_from <= CURRENT_DATE
    AND (existing.valid_until IS NULL OR existing.valid_until >= CURRENT_DATE)
);

COMMIT;
