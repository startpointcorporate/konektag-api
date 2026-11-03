BEGIN;

-- Merchant products remain the offer identity; pricing rules remain the price context.
CREATE UNIQUE INDEX uq_core_product_owner ON konektag.merchant_products(id, merchant_profile_id);
CREATE UNIQUE INDEX uq_core_pricing_owner ON konektag.product_pricing_rules(id, merchant_profile_id);
CREATE UNIQUE INDEX uq_core_payment_owner ON konektag.api_payment_orders(id, merchant_profile_id);
ALTER TABLE konektag.product_pricing_rules ADD COLUMN merchant_product_id UUID;
ALTER TABLE konektag.product_pricing_rules ADD CONSTRAINT fk_core_pricing_offer
  FOREIGN KEY (merchant_product_id, merchant_profile_id) REFERENCES konektag.merchant_products(id, merchant_profile_id);
CREATE UNIQUE INDEX uq_core_pricing_offer_identity
  ON konektag.product_pricing_rules(id, merchant_profile_id, merchant_product_id);

CREATE TABLE konektag.core_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  kind TEXT NOT NULL CHECK (kind IN ('PERSON','PLACE','EQUIPMENT','STOCK','OTHER')),
  label TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, merchant_profile_id)
);
CREATE TABLE konektag.core_capacities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  unit_code TEXT NOT NULL,
  UNIQUE (id, merchant_profile_id),
  FOREIGN KEY (resource_id, merchant_profile_id) REFERENCES konektag.core_resources(id, merchant_profile_id)
);
CREATE TABLE konektag.core_availabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL,
  capacity_id UUID NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  available_units INTEGER NOT NULL CHECK (available_units > 0),
  CHECK (ends_at > starts_at),
  UNIQUE (id, merchant_profile_id),
  FOREIGN KEY (capacity_id, merchant_profile_id) REFERENCES konektag.core_capacities(id, merchant_profile_id)
);

CREATE TABLE konektag.core_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  customer_user_id UUID NOT NULL REFERENCES konektag.users(id),
  kind TEXT NOT NULL CHECK (kind IN ('ORDER','RESERVATION','REQUEST')),
  state TEXT NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','CONFIRMED','ALLOCATED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED','EXPIRED','REJECTED','DISPUTED')),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version > 0),
  currency VARCHAR(3) NOT NULL,
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payment_order_id UUID REFERENCES konektag.api_payment_orders(id),
  scheduled_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_profile_id, request_key),
  UNIQUE (id, merchant_profile_id),
  UNIQUE (id, customer_user_id),
  UNIQUE (id, merchant_profile_id, currency),
  FOREIGN KEY (payment_order_id, merchant_profile_id) REFERENCES konektag.api_payment_orders(id, merchant_profile_id)
);
CREATE INDEX idx_core_transactions_customer ON konektag.core_transactions(customer_user_id, kind, created_at DESC);
CREATE TABLE konektag.core_transaction_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  merchant_profile_id UUID NOT NULL,
  offer_id UUID,
  pricing_rule_id UUID,
  label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
  currency VARCHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pricing_rule_id IS NULL OR offer_id IS NOT NULL),
  UNIQUE (id, merchant_profile_id),
  FOREIGN KEY (transaction_id, merchant_profile_id) REFERENCES konektag.core_transactions(id, merchant_profile_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, merchant_profile_id, currency) REFERENCES konektag.core_transactions(id, merchant_profile_id, currency),
  FOREIGN KEY (offer_id, merchant_profile_id) REFERENCES konektag.merchant_products(id, merchant_profile_id),
  FOREIGN KEY (pricing_rule_id, merchant_profile_id) REFERENCES konektag.product_pricing_rules(id, merchant_profile_id),
  FOREIGN KEY (pricing_rule_id, merchant_profile_id, offer_id)
    REFERENCES konektag.product_pricing_rules(id, merchant_profile_id, merchant_product_id)
);
CREATE TABLE konektag.core_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL,
  transaction_line_id UUID NOT NULL,
  availability_id UUID NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (transaction_line_id, merchant_profile_id) REFERENCES konektag.core_transaction_lines(id, merchant_profile_id),
  FOREIGN KEY (availability_id, merchant_profile_id) REFERENCES konektag.core_availabilities(id, merchant_profile_id)
);
CREATE INDEX idx_core_allocations_active ON konektag.core_allocations(availability_id) WHERE state = 'ACTIVE';
CREATE TABLE konektag.core_transition_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  merchant_profile_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES konektag.users(id),
  command_key TEXT NOT NULL,
  command TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, command_key),
  UNIQUE (transaction_id, to_version),
  FOREIGN KEY (transaction_id, merchant_profile_id) REFERENCES konektag.core_transactions(id, merchant_profile_id)
);

CREATE TABLE konektag.core_offline_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES konektag.users(id),
  public_key TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK ((state = 'PENDING' AND activated_at IS NULL AND revoked_at IS NULL)
      OR (state = 'ACTIVE' AND activated_at IS NOT NULL AND revoked_at IS NULL)
      OR (state = 'REVOKED' AND revoked_at IS NOT NULL)),
  UNIQUE (id, owner_user_id)
);
CREATE UNIQUE INDEX uq_core_active_offline_device ON konektag.core_offline_devices(owner_user_id) WHERE state = 'ACTIVE';
CREATE TABLE konektag.core_offline_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  currency VARCHAR(3) NOT NULL,
  maximum_count INTEGER NOT NULL CHECK (maximum_count BETWEEN 1 AND 10),
  maximum_total_minor BIGINT NOT NULL CHECK (maximum_total_minor > 0),
  maximum_single_minor BIGINT NOT NULL CHECK (maximum_single_minor > 0 AND maximum_single_minor <= maximum_total_minor),
  total_eur_equivalent_minor INTEGER NOT NULL CHECK (total_eur_equivalent_minor BETWEEN 1 AND 30000),
  single_eur_equivalent_minor INTEGER NOT NULL CHECK (single_eur_equivalent_minor BETWEEN 1 AND 5000),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  server_decision TEXT NOT NULL CHECK (server_decision IN ('APPROVED','REVOKED')),
  decision_version INTEGER NOT NULL CHECK (decision_version > 0),
  CHECK (expires_at > starts_at AND expires_at <= starts_at + INTERVAL '24 hours'),
  UNIQUE (id, device_id, owner_user_id),
  UNIQUE (id, device_id),
  FOREIGN KEY (device_id, owner_user_id) REFERENCES konektag.core_offline_devices(id, owner_user_id)
);
CREATE TABLE konektag.core_transaction_offline (
  transaction_id UUID PRIMARY KEY REFERENCES konektag.core_transactions(id),
  authorization_id UUID NOT NULL,
  device_id UUID NOT NULL,
  client_transaction_id TEXT NOT NULL,
  local_counter BIGINT NOT NULL CHECK (local_counter >= 0),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  proofs JSONB NOT NULL CHECK (jsonb_typeof(proofs) = 'object'),
  sync_state TEXT NOT NULL CHECK (sync_state IN ('CREATED','DELIVERED_TO_MERCHANT','SYNC_PENDING','SYNCING','SETTLED','REJECTED','CONFLICT','REQUIRES_REVIEW')),
  conflict_reason TEXT,
  arbitration_order BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, client_transaction_id),
  FOREIGN KEY (authorization_id, device_id) REFERENCES konektag.core_offline_authorizations(id, device_id)
);
CREATE UNIQUE INDEX uq_core_one_settled_counter
  ON konektag.core_transaction_offline(device_id, local_counter) WHERE sync_state='SETTLED';
CREATE FUNCTION konektag.core_check_offline_transaction_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM konektag.core_offline_authorizations a
    JOIN konektag.core_transactions t ON t.id = NEW.transaction_id
    WHERE a.id = NEW.authorization_id AND a.device_id = NEW.device_id
      AND a.owner_user_id = t.customer_user_id AND a.currency = t.currency
  ) THEN RAISE EXCEPTION 'offline transaction owner or currency mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_check_offline_transaction_owner BEFORE INSERT OR UPDATE OF transaction_id,authorization_id,device_id
  ON konektag.core_transaction_offline FOR EACH ROW EXECUTE FUNCTION konektag.core_check_offline_transaction_owner();
CREATE FUNCTION konektag.core_preserve_offline_proofs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sync_state <> 'SETTLED' OR EXISTS (
    SELECT 1 FROM konektag.core_transactions t WHERE t.id=OLD.transaction_id AND t.state='DISPUTED'
  ) THEN RAISE EXCEPTION 'offline proof must be retained until settled and undisputed'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER core_preserve_offline_proofs BEFORE DELETE ON konektag.core_transaction_offline
  FOR EACH ROW EXECUTE FUNCTION konektag.core_preserve_offline_proofs();
CREATE FUNCTION konektag.core_protect_offline_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proofs IS DISTINCT FROM OLD.proofs OR NEW.envelope IS DISTINCT FROM OLD.envelope
     OR NEW.client_transaction_id IS DISTINCT FROM OLD.client_transaction_id
     OR NEW.local_counter IS DISTINCT FROM OLD.local_counter THEN
    RAISE EXCEPTION 'offline evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_protect_offline_evidence BEFORE UPDATE ON konektag.core_transaction_offline
  FOR EACH ROW EXECUTE FUNCTION konektag.core_protect_offline_evidence();

COMMIT;
