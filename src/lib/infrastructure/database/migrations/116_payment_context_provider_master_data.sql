-- Migration 116 : contexte Payment et provider technique des acteurs regules

BEGIN;

ALTER TABLE konektag.regulated_actors
  ADD COLUMN IF NOT EXISTS technical_provider VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_regulated_actors_technical_provider
  ON konektag.regulated_actors(technical_provider)
  WHERE deleted_at IS NULL AND technical_provider IS NOT NULL;

-- Master data runtime required by the Payment Context API.
UPDATE konektag.legal_entities
SET status = 'APPROVED', valid_from = COALESCE(valid_from, CURRENT_DATE), updated_at = now()
WHERE code = 'KTG-FR' AND deleted_at IS NULL;

UPDATE konektag.regulated_actors
SET status = 'APPROVED', technical_provider = 'stripe', jurisdiction = 'FR',
    license_ref = COALESCE(license_ref, 'stripe-fr-master-data'),
    license_valid_from = COALESCE(license_valid_from, CURRENT_DATE),
    updated_at = now()
WHERE actor_code = 'STRIPE-FR' AND deleted_at IS NULL;

INSERT INTO konektag.regulatory_profiles (
  profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
  corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
  execution_mode, min_kyc_level, status, valid_from
)
SELECT
  'LINK-FR-STRIPE', 'Paiement par lien Stripe France', le.id, 'FR', 'FR',
  'FR-FR', 'link_payment', 'regulated_actor', ra.id, 'stripe',
  'provider_confirmation', 'basic', 'APPROVED', CURRENT_DATE
FROM konektag.legal_entities le
JOIN konektag.regulated_actors ra ON ra.actor_code = 'STRIPE-FR' AND ra.deleted_at IS NULL
WHERE le.code = 'KTG-FR' AND le.deleted_at IS NULL
ON CONFLICT (profile_code) DO UPDATE SET
  legal_entity_id = EXCLUDED.legal_entity_id,
  country_of_origin = EXCLUDED.country_of_origin,
  country_of_destination = EXCLUDED.country_of_destination,
  corridor_id = EXCLUDED.corridor_id,
  authorized_operation = EXCLUDED.authorized_operation,
  fund_holder = EXCLUDED.fund_holder,
  regulated_actor_id = EXCLUDED.regulated_actor_id,
  rail = EXCLUDED.rail,
  execution_mode = EXCLUDED.execution_mode,
  min_kyc_level = EXCLUDED.min_kyc_level,
  status = EXCLUDED.status,
  valid_from = EXCLUDED.valid_from,
  valid_until = NULL,
  updated_at = now();

COMMIT;
