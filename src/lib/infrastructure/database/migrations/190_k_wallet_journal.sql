BEGIN;

-- Canonical user K wallet journal. One row = one effective wallet movement.
CREATE TABLE konektag.k_wallet_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id UUID NOT NULL REFERENCES konektag.parties(id),
  operation_id UUID NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('purchase','k_send','payment','cashback','bonus','refund','adjustment')),
  direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  quantity_k BIGINT NOT NULL CHECK (quantity_k > 0),
  counterparty_party_id UUID REFERENCES konektag.parties(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(operation_id, party_id, direction)
);
CREATE INDEX idx_k_wallet_entries_party_created ON konektag.k_wallet_entries(party_id,created_at DESC);

-- Existing completed user-facing K entries are the opening journal. This copies
-- effective wallet movements only; it does not reconstruct purchases from PSP data.
INSERT INTO konektag.k_wallet_entries
 (party_id,operation_id,operation_type,direction,quantity_k,source_type,source_id,created_at)
SELECT e.party_id,e.transaction_id,
 CASE
   WHEN t.transaction_type='acquisition' THEN 'purchase'
   WHEN t.transaction_type='consumption' THEN 'payment'
   WHEN t.transaction_type='refund' THEN 'refund'
   WHEN t.transaction_type='reversal' THEN 'refund'
   WHEN e.document_type='Cashback' THEN 'cashback'
   ELSE 'adjustment'
 END,
 e.entry_side, e.amount::bigint,
 'legacy_ledger', e.id::text, e.created_at
FROM konektag.ledger_entries e
JOIN konektag.financial_transactions t ON t.id=e.transaction_id
WHERE e.party_id IS NOT NULL AND e.account_code='1000' AND e.currency='K'
  AND e.gl_scope='GLOBAL_USER_GL' AND t.status IN ('completed','reversed')
  AND e.amount=trunc(e.amount) AND e.amount>0
ON CONFLICT(operation_id,party_id,direction) DO NOTHING;

-- Import completed autonomous K sends exactly once as wallet movements.
INSERT INTO konektag.k_wallet_entries
 (party_id,operation_id,operation_type,direction,quantity_k,counterparty_party_id,source_type,source_id,created_at)
SELECT x.sender_party_id,x.id,'k_send','debit',x.quantity_k,x.recipient_party_id,'k_send',x.operation_key,x.created_at
FROM konektag.k_points_transfers x
ON CONFLICT(operation_id,party_id,direction) DO NOTHING;
INSERT INTO konektag.k_wallet_entries
 (party_id,operation_id,operation_type,direction,quantity_k,counterparty_party_id,source_type,source_id,created_at)
SELECT x.recipient_party_id,x.id,'k_send','credit',x.quantity_k,x.sender_party_id,'k_send',x.operation_key,x.created_at
FROM konektag.k_points_transfers x
ON CONFLICT(operation_id,party_id,direction) DO NOTHING;

ALTER TABLE konektag.k_send_intents DROP COLUMN IF EXISTS points_transfer_id;
DROP TABLE IF EXISTS konektag.k_points_transfers;

CREATE OR REPLACE FUNCTION konektag.k_wallet_balance(p_party UUID)
RETURNS BIGINT LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN quantity_k ELSE -quantity_k END),0)::bigint
 FROM konektag.k_wallet_entries WHERE party_id=p_party;
$$;

COMMIT;
