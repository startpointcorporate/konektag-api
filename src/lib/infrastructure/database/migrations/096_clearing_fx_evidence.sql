-- Immutable, provider-neutral FX evidence for cross-currency clearing.
BEGIN;

CREATE TABLE IF NOT EXISTS konektag.clearing_fx_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clearing_batch_id UUID NOT NULL UNIQUE REFERENCES konektag.clearing_batches(id),
  source_currency VARCHAR(10) NOT NULL CHECK (btrim(source_currency) <> ''),
  target_currency VARCHAR(10) NOT NULL CHECK (btrim(target_currency) <> ''),
  rate NUMERIC(20,8) NOT NULL CHECK (rate > 0),
  evidence_ref VARCHAR(200) NOT NULL UNIQUE CHECK (btrim(evidence_ref) <> ''),
  rate_source VARCHAR(100) NOT NULL CHECK (btrim(rate_source) <> ''),
  valued_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_currency <> target_currency)
);

CREATE OR REPLACE FUNCTION konektag.prevent_clearing_fx_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Clearing FX evidence is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_clearing_fx_evidence ON konektag.clearing_fx_evidence;
CREATE TRIGGER trg_immutable_clearing_fx_evidence
  BEFORE UPDATE OR DELETE ON konektag.clearing_fx_evidence
  FOR EACH ROW EXECUTE FUNCTION konektag.prevent_clearing_fx_evidence_mutation();

COMMIT;
