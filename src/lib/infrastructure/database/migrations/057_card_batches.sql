CREATE TABLE IF NOT EXISTS konektag.card_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_start BIGINT NOT NULL,
  size         INT NOT NULL,
  amount       INT NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS konektag.cards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number       VARCHAR(16) NOT NULL,
  pin          VARCHAR(64) NOT NULL,
  amount       INT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'INACTIVE',
  batch_id     UUID REFERENCES konektag.card_batches(id),
  sold_at      TIMESTAMPTZ,
  sold_by      UUID REFERENCES konektag.users(id),
  redeemed_at  TIMESTAMPTZ,
  redeemed_by  UUID REFERENCES konektag.users(id),
  version      INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT valid_status CHECK (status IN ('INACTIVE', 'SOLD', 'REDEEMED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_number ON konektag.cards(number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cards_status ON konektag.cards(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cards_batch ON konektag.cards(batch_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS konektag.card_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      UUID REFERENCES konektag.cards(id),
  action       VARCHAR(30) NOT NULL,
  user_id      UUID,
  ip_address   VARCHAR(50),
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_card_audit_card ON konektag.card_audit_log(card_id);
