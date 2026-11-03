-- P03/P04/P05 regulated operation hardening.  Additive only: existing cards and
-- users keep their current state and every new operation has a durable audit trail.
BEGIN;

ALTER TABLE konektag.card_batches
  ADD COLUMN IF NOT EXISTS legal_entity_id UUID REFERENCES konektag.legal_entities(id),
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2),
  ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'MANUFACTURED',
  ADD COLUMN IF NOT EXISTS distributed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE konektag.cards
  ADD COLUMN IF NOT EXISTS legal_entity_id UUID REFERENCES konektag.legal_entities(id),
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2),
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT,
  ADD COLUMN IF NOT EXISTS financial_transaction_id UUID REFERENCES konektag.financial_transactions(id);

ALTER TABLE konektag.cards DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE konektag.cards ADD CONSTRAINT valid_status
  CHECK (status IN ('GENERATED', 'DISTRIBUTED', 'SOLD', 'ACTIVATED', 'CANCELLED', 'BLOCKED'));
ALTER TABLE konektag.card_batches DROP CONSTRAINT IF EXISTS card_batches_lifecycle_status_check;
ALTER TABLE konektag.card_batches ADD CONSTRAINT card_batches_lifecycle_status_check
  CHECK (lifecycle_status IN ('MANUFACTURED', 'DISTRIBUTED', 'CANCELLED', 'BLOCKED'));
CREATE INDEX IF NOT EXISTS idx_cards_lifecycle_entity ON konektag.cards(legal_entity_id, country_code, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS konektag.card_sale_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_user_id UUID NOT NULL REFERENCES konektag.users(id),
  declaration_ref VARCHAR(255) NOT NULL UNIQUE,
  country_code VARCHAR(2) NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  card_count INTEGER NOT NULL CHECK (card_count > 0),
  total_amount NUMERIC(20,6) NOT NULL CHECK (total_amount > 0),
  evidence_url TEXT,
  maker_id UUID NOT NULL REFERENCES konektag.users(id),
  checker_id UUID REFERENCES konektag.users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'DECLARED' CHECK (status IN ('DECLARED', 'APPROVED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS konektag.card_sale_declaration_cards (
  declaration_id UUID NOT NULL REFERENCES konektag.card_sale_declarations(id),
  card_id UUID NOT NULL REFERENCES konektag.cards(id),
  PRIMARY KEY (declaration_id, card_id), UNIQUE(card_id)
);

ALTER TABLE konektag.account_access_actions
  ADD COLUMN IF NOT EXISTS source_system VARCHAR(16) NOT NULL DEFAULT 'KONEKTAG',
  ADD COLUMN IF NOT EXISTS external_reference VARCHAR(255),
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_account_access_actions_retry
  ON konektag.account_access_actions(keycloak_status, next_retry_at)
  WHERE keycloak_status = 'PENDING';

COMMIT;
