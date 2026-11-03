-- Accounting events may only be emitted for transactions assigned to a legal entity.
-- This remains a trigger instead of a NOT NULL constraint so unfinished non-accounting
-- transaction drafts can still exist without entering the accounting workflow.
BEGIN;

CREATE OR REPLACE FUNCTION konektag.require_legal_entity_for_accounting_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM konektag.financial_transactions
    WHERE id = NEW.financial_transaction_id
      AND legal_entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'accounting_outbox requires financial_transactions.legal_entity_id for transaction %', NEW.financial_transaction_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS require_legal_entity_for_accounting_outbox ON konektag.accounting_outbox;

CREATE TRIGGER require_legal_entity_for_accounting_outbox
BEFORE INSERT OR UPDATE OF financial_transaction_id ON konektag.accounting_outbox
FOR EACH ROW
EXECUTE FUNCTION konektag.require_legal_entity_for_accounting_outbox();

COMMIT;
