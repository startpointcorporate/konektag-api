BEGIN;

-- Reconcile historical wallet movements that have no canonical ledger
-- transaction (legacy autonomous K sends). The existing operation UUID is kept,
-- so retries and downstream references remain stable. Each projection row is
-- relinked to its immutable ledger proof before the transaction is finalized;
-- the deferred projection trigger therefore cannot duplicate it.
DO $$
DECLARE operation uuid; movement record; ledger_id uuid;
BEGIN
 FOR operation IN
  SELECT DISTINCT w.operation_id FROM konektag.k_wallet_entries w
  WHERE NOT EXISTS(SELECT 1 FROM konektag.financial_transactions ft WHERE ft.id=w.operation_id)
 LOOP
  INSERT INTO konektag.financial_transactions
   (id,transaction_type,business_reference,idempotency_key,currency,status,accounting_status)
  VALUES(operation,'k_send','legacy-k-send:'||operation,'legacy-k-wallet:'||operation,'K','pending','pending');

  FOR movement IN SELECT * FROM konektag.k_wallet_entries WHERE operation_id=operation ORDER BY id
  LOOP
   INSERT INTO konektag.ledger_entries
    (transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,operation_id)
   VALUES(operation,'1000',movement.direction,movement.direction,movement.party_id,movement.quantity_k,'K',
    'k_send',movement.source_id,'legacy-k-wallet:'||operation)
   RETURNING id INTO ledger_id;

   UPDATE konektag.k_wallet_entries SET source_type='legacy_ledger',source_id=ledger_id::text
   WHERE id=movement.id;
  END LOOP;

  UPDATE konektag.financial_transactions
   SET status='completed',accounting_status='posted',completed_at=now(),accounting_posted_at=now()
   WHERE id=operation;
 END LOOP;
END $$;

-- Keep the compatibility SQL function, but derive it from the same canonical
-- facts as /balance and /history. k_wallet_entries is projection-only now.
CREATE OR REPLACE FUNCTION konektag.points_balance(p_owner uuid)
RETURNS TABLE(balance numeric,reserved numeric,available numeric)
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT b.n,r.n,b.n-r.n FROM
 (SELECT COALESCE(sum(CASE WHEN le.entry_side='credit' THEN le.amount ELSE -le.amount END),0)::numeric n
  FROM konektag.ledger_entries le JOIN konektag.financial_transactions ft ON ft.id=le.transaction_id
  WHERE le.party_id=p_owner AND le.account_code='1000' AND le.currency='K' AND le.gl_scope='GLOBAL_USER_GL'
   AND ft.status IN ('completed','reversed')) b CROSS JOIN
 (SELECT COALESCE(sum(amount),0)::numeric n FROM konektag.api_payment_wallet_reservations
  WHERE payer_party_id=p_owner AND currency='K' AND lifecycle='active' AND expires_at>statement_timestamp()) r;
$$;

COMMIT;
