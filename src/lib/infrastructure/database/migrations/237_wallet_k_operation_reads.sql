BEGIN;
-- Both existing ledger parent domains contribute to the same K wallet.
-- No entry is copied, reclassified or created by this read-model correction.
CREATE OR REPLACE FUNCTION konektag.points_balance(p_owner uuid)
RETURNS TABLE(balance numeric,reserved numeric,available numeric)
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT b.n,r.n,b.n-r.n FROM
 (SELECT COALESCE(sum(CASE WHEN le.entry_side='credit' THEN le.amount ELSE -le.amount END),0)::numeric n
  FROM konektag.ledger_entries le
  LEFT JOIN konektag.financial_transactions ft ON ft.id=le.transaction_id
  LEFT JOIN konektag.k_operations ko ON ko.id=le.k_operation_id
  WHERE le.party_id=p_owner AND le.account_code='1000' AND le.currency='K' AND le.gl_scope='GLOBAL_USER_GL'
   AND COALESCE(ko.status,ft.status) IN ('completed','reversed')) b CROSS JOIN
 (SELECT COALESCE(sum(amount),0)::numeric n FROM konektag.api_payment_wallet_reservations
  WHERE payer_party_id=p_owner AND currency='K' AND lifecycle='active' AND expires_at>statement_timestamp()) r;
$$;
COMMIT;
