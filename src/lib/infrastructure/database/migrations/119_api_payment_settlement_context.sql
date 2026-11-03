-- Preserve the Payment Context selected before asynchronous provider settlement.
BEGIN;

ALTER TABLE konektag.api_payment_orders
  ADD COLUMN IF NOT EXISTS settlement_legal_entity_id UUID REFERENCES konektag.legal_entities(id),
  ADD COLUMN IF NOT EXISTS settlement_regulatory_profile_id UUID REFERENCES konektag.regulatory_profiles(id),
  ADD COLUMN IF NOT EXISTS settlement_corridor_id VARCHAR(30),
  ADD COLUMN IF NOT EXISTS settlement_regulated_actor_id UUID REFERENCES konektag.regulated_actors(id),
  ADD COLUMN IF NOT EXISTS settlement_rail VARCHAR(30),
  ADD COLUMN IF NOT EXISTS settlement_provider VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_settlement_profile
  ON konektag.api_payment_orders(settlement_regulatory_profile_id)
  WHERE settlement_regulatory_profile_id IS NOT NULL;

COMMIT;
