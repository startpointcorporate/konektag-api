-- Holds an approved API-checkout Wallet contribution until its external leg settles.
CREATE TABLE IF NOT EXISTS konektag.api_payment_wallet_reservations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id         UUID NOT NULL UNIQUE REFERENCES konektag.api_payment_orders(id),
  authorization_id         UUID NOT NULL UNIQUE REFERENCES konektag.wallet_debit_authorizations(id),
  payer_party_id           UUID NOT NULL REFERENCES konektag.parties(id),
  amount                   BIGINT NOT NULL CHECK (amount > 0),
  currency                 VARCHAR(3) NOT NULL CHECK (currency = upper(currency)),
  lifecycle                VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'captured', 'released', 'expired')),
  reserved_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL,
  captured_at              TIMESTAMPTZ,
  released_at              TIMESTAMPTZ,
  release_reason           VARCHAR(40),
  version                  INTEGER NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lifecycle <> 'captured' AND captured_at IS NULL) OR captured_at IS NOT NULL),
  CHECK ((lifecycle NOT IN ('released', 'expired') AND released_at IS NULL) OR released_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_api_payment_wallet_reservations_available_balance
  ON konektag.api_payment_wallet_reservations(payer_party_id, currency, expires_at)
  WHERE lifecycle = 'active';

-- Terminal checkout states cannot leave a Wallet hold behind.
CREATE OR REPLACE FUNCTION konektag.release_api_payment_wallet_reservation_on_terminal_state()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state IN ('failed', 'expired') AND OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE konektag.api_payment_wallet_reservations
    SET lifecycle = 'released', released_at = now(), release_reason = NEW.state,
        updated_at = now(), version = version + 1
    WHERE payment_order_id = NEW.id AND lifecycle = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_api_payment_wallet_reservation ON konektag.api_payment_orders;
CREATE TRIGGER trg_release_api_payment_wallet_reservation
  AFTER UPDATE OF state ON konektag.api_payment_orders
  FOR EACH ROW EXECUTE FUNCTION konektag.release_api_payment_wallet_reservation_on_terminal_state();
