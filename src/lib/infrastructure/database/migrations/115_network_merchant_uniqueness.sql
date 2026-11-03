-- A legal entity owns exactly one internal NETWORK beneficiary.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_profiles_network_per_legal_entity
  ON konektag.merchant_profiles(legal_entity_id)
  WHERE beneficiary_type = 'NETWORK' AND deleted_at IS NULL;
