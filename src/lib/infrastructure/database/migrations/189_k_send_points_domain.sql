BEGIN;

CREATE TABLE konektag.k_points_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_party_id UUID NOT NULL REFERENCES konektag.parties(id),
  recipient_party_id UUID NOT NULL REFERENCES konektag.parties(id),
  quantity_k BIGINT NOT NULL CHECK (quantity_k > 0),
  operation_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_party_id <> recipient_party_id)
);
CREATE INDEX idx_k_points_transfers_sender ON konektag.k_points_transfers(sender_party_id, created_at DESC);
CREATE INDEX idx_k_points_transfers_recipient ON konektag.k_points_transfers(recipient_party_id, created_at DESC);

DROP INDEX IF EXISTS konektag.uq_k_send_intents_financial_transaction;
ALTER TABLE konektag.k_send_intents
  DROP COLUMN IF EXISTS financial_transaction_id,
  DROP COLUMN IF EXISTS source_currency,
  ADD COLUMN points_transfer_id UUID REFERENCES konektag.k_points_transfers(id);
CREATE UNIQUE INDEX uq_k_send_intents_points_transfer ON konektag.k_send_intents(points_transfer_id) WHERE points_transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION konektag.points_balance(p_owner UUID)
RETURNS TABLE(balance NUMERIC, reserved NUMERIC, available NUMERIC)
LANGUAGE SQL STABLE SET search_path = pg_catalog AS $$
  WITH legacy AS (
    SELECT COALESCE(SUM(CASE WHEN e.entry_side = 'credit' THEN e.amount ELSE -e.amount END), 0) AS amount
    FROM konektag.ledger_entries e
    JOIN konektag.financial_transactions t ON t.id = e.transaction_id
    WHERE e.party_id = p_owner AND e.account_code = '1000' AND e.currency = 'K'
      AND e.gl_scope = 'GLOBAL_USER_GL' AND t.status IN ('completed', 'reversed')
  ), k_moves AS (
    SELECT COALESCE(SUM(CASE WHEN x.recipient_party_id = p_owner THEN x.quantity_k ELSE -x.quantity_k END), 0) AS amount
    FROM konektag.k_points_transfers x
    WHERE x.sender_party_id = p_owner OR x.recipient_party_id = p_owner
  ), holds AS (
    SELECT COALESCE(SUM(r.amount), 0) AS amount
    FROM konektag.api_payment_wallet_reservations r
    WHERE r.payer_party_id = p_owner AND r.currency = 'K'
      AND r.lifecycle = 'active' AND r.expires_at > statement_timestamp()
  )
  SELECT legacy.amount + k_moves.amount, holds.amount,
         legacy.amount + k_moves.amount - holds.amount
  FROM legacy CROSS JOIN k_moves CROSS JOIN holds;
$$;

COMMIT;
