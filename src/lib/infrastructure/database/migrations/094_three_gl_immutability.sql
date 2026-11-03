-- GAP-020: explicit Runbook V3 General Ledger scopes and append-only entries.
BEGIN;

ALTER TABLE konektag.ledger_entries
  ADD COLUMN IF NOT EXISTS gl_scope VARCHAR(32),
  ADD COLUMN IF NOT EXISTS legacy_classification VARCHAR(32);

ALTER TABLE konektag.ledger_entries
  ADD CONSTRAINT ck_ledger_gl_scope CHECK (gl_scope IS NULL OR gl_scope IN
    ('GLOBAL_USER_GL', 'KONEKTAG_FRANCE_GL', 'KONEKTAG_CONGO_GL'));

-- Historical rows are retained, never guessed: they cannot be treated as V3-final
-- until a controlled reconciliation/backfill classifies them.
UPDATE konektag.ledger_entries
SET legacy_classification = 'REQUIRES_RECONCILIATION'
WHERE gl_scope IS NULL AND legacy_classification IS NULL;

CREATE OR REPLACE FUNCTION konektag.derive_v3_gl_scope() RETURNS trigger AS $$
DECLARE entity_code text;
BEGIN
  IF NEW.transaction_id IS NULL OR NEW.operation_id IS NULL THEN
    NEW.legacy_classification := COALESCE(NEW.legacy_classification, 'REQUIRES_RECONCILIATION');
    RETURN NEW;
  END IF;
  IF NEW.legal_entity_id IS NULL OR NEW.currency IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0
     OR NEW.entry_side IS NULL OR NEW.account_code IS NULL OR NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'V3 ledger entry requires legal entity, currency, amount, side, account and operation identity';
  END IF;
  SELECT code INTO entity_code FROM konektag.legal_entities WHERE id = NEW.legal_entity_id AND deleted_at IS NULL;
  IF entity_code NOT IN ('KTG-FR', 'KTG-CG') THEN RAISE EXCEPTION 'Unknown V3 legal entity scope'; END IF;
  NEW.gl_scope := CASE WHEN NEW.account_code = '1000' THEN 'GLOBAL_USER_GL'
    WHEN entity_code = 'KTG-FR' THEN 'KONEKTAG_FRANCE_GL' ELSE 'KONEKTAG_CONGO_GL' END;
  NEW.legacy_classification := NULL;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_derive_v3_gl_scope ON konektag.ledger_entries;
CREATE TRIGGER trg_derive_v3_gl_scope BEFORE INSERT ON konektag.ledger_entries
FOR EACH ROW EXECUTE FUNCTION konektag.derive_v3_gl_scope();

CREATE OR REPLACE FUNCTION konektag.prevent_final_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM konektag.financial_transactions WHERE id = OLD.transaction_id AND status IN ('completed','reversed')) THEN
    RAISE EXCEPTION 'Finalized ledger entries are append-only; create a compensating entry';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_immutable_final_ledger ON konektag.ledger_entries;
CREATE TRIGGER trg_immutable_final_ledger BEFORE UPDATE OR DELETE ON konektag.ledger_entries
FOR EACH ROW EXECUTE FUNCTION konektag.prevent_final_ledger_mutation();
COMMIT;
