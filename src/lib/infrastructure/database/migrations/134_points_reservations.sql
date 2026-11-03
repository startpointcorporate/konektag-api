BEGIN;

-- Extend the existing checkout holds rather than introducing a second balance.
-- Existing rows and lifecycle values are preserved for compatibility.
ALTER TABLE konektag.api_payment_wallet_reservations
  ALTER COLUMN payment_order_id DROP NOT NULL,
  ALTER COLUMN authorization_id DROP NOT NULL,
  ADD COLUMN operation_key TEXT,
  ADD COLUMN consumption_transaction_id UUID REFERENCES konektag.financial_transactions(id),
  ADD CONSTRAINT points_reservation_operation_key UNIQUE(operation_key),
  ADD CONSTRAINT points_reservation_consumption_unique UNIQUE(consumption_transaction_id),
  ADD CONSTRAINT points_reservation_reference CHECK(payment_order_id IS NOT NULL OR operation_key IS NOT NULL);

CREATE OR REPLACE FUNCTION konektag.points_balance(p_owner UUID)
RETURNS TABLE(balance NUMERIC, reserved NUMERIC, available NUMERIC)
LANGUAGE SQL STABLE SET search_path = pg_catalog AS $$
  WITH totals AS (
    SELECT COALESCE(SUM(CASE WHEN e.entry_side = 'credit' THEN e.amount ELSE -e.amount END), 0) AS balance
    FROM konektag.ledger_entries e
    JOIN konektag.financial_transactions t ON t.id = e.transaction_id
    WHERE e.party_id = p_owner AND e.account_code = '1000' AND e.currency = 'K'
      AND e.gl_scope = 'GLOBAL_USER_GL' AND t.status IN ('completed', 'reversed')
  ), holds AS (
    SELECT COALESCE(SUM(r.amount), 0) AS reserved
    FROM konektag.api_payment_wallet_reservations r
    WHERE r.payer_party_id = p_owner AND r.currency = 'K'
      AND r.lifecycle = 'active' AND r.expires_at > statement_timestamp()
  )
  SELECT totals.balance, holds.reserved, totals.balance - holds.reserved FROM totals CROSS JOIN holds;
$$;

-- Admission and expiry share the same lock as the K consumption service.
-- This also protects checkout callers which still insert their hold directly.
CREATE FUNCTION konektag.guard_points_reservation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_available NUMERIC; v_valid BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.currency = 'K' THEN
    IF ROW(NEW.payer_party_id, NEW.amount, NEW.currency, NEW.operation_key,
           NEW.payment_order_id, NEW.authorization_id, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.payer_party_id, OLD.amount, OLD.currency, OLD.operation_key,
           OLD.payment_order_id, OLD.authorization_id, OLD.expires_at) THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_IMMUTABLE';
    END IF;
    IF OLD.lifecycle <> 'active' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_TERMINAL';
    END IF;
  END IF;
  IF NEW.currency <> 'K' THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('points-wallet:' || NEW.payer_party_id::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'active' OR NEW.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_NOT_ACTIVE';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM konektag.parties WHERE id = NEW.payer_party_id AND is_active) THEN
      RAISE EXCEPTION 'POINTS_OWNER_UNAVAILABLE';
    END IF;
    SELECT b.available INTO v_available FROM konektag.points_balance(NEW.payer_party_id) b;
    IF NEW.amount > v_available THEN RAISE EXCEPTION 'POINTS_INSUFFICIENT'; END IF;
  ELSIF NEW.lifecycle = 'captured' AND OLD.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'POINTS_RESERVATION_EXPIRED';
  END IF;
  IF NEW.operation_key IS NOT NULL AND NEW.lifecycle = 'captured' THEN
    SELECT count(*) = 2 AND bool_and(e.currency = 'K' AND e.amount = NEW.amount
      AND e.gl_scope = 'GLOBAL_USER_GL' AND
      ((e.account_code = '1000' AND e.entry_side = 'debit' AND e.party_id = NEW.payer_party_id)
       OR (e.account_code = 'K_ISSUANCE' AND e.entry_side = 'credit' AND e.party_id IS NULL)))
      INTO v_valid
    FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id = e.transaction_id
    WHERE t.id = NEW.consumption_transaction_id AND t.currency = 'K'
      AND t.transaction_type = 'consumption' AND t.status = 'completed';
    IF v_valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_points_reservation
BEFORE INSERT OR UPDATE ON konektag.api_payment_wallet_reservations
FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_reservation();

-- No SECURITY DEFINER: callers must retain their own data access permissions.
REVOKE ALL ON FUNCTION konektag.points_balance(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION konektag.guard_points_reservation() FROM PUBLIC;

COMMIT;
