-- Persist authoritative FX evidence for gift quotes without changing ledger semantics.
BEGIN;

ALTER TABLE konektag.exchange_rates
  ADD COLUMN IF NOT EXISTS rate_source VARCHAR(100),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE konektag.gift_intents
  DROP CONSTRAINT IF EXISTS gift_intents_receive_amount_check;

ALTER TABLE konektag.gift_intents
  ADD COLUMN IF NOT EXISTS destination_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS exchange_rate_id UUID REFERENCES konektag.exchange_rates(id),
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(21,9),
  ADD COLUMN IF NOT EXISTS fx_rate_source VARCHAR(100),
  ADD COLUMN IF NOT EXISTS fx_rate_timestamp TIMESTAMPTZ;

UPDATE konektag.gift_intents
SET destination_currency = source_currency
WHERE destination_currency IS NULL AND origin_country = destination_country;

ALTER TABLE konektag.gift_intents
  ALTER COLUMN destination_currency SET NOT NULL,
  ADD CONSTRAINT gift_intents_receive_amount_positive CHECK (receive_amount > 0),
  ADD CONSTRAINT gift_intents_currency_and_fx_evidence CHECK (
    (
      origin_country = destination_country
      AND source_currency = destination_currency
      AND receive_amount = source_amount
      AND exchange_rate_id IS NULL
      AND fx_rate IS NULL
      AND fx_rate_source IS NULL
      AND fx_rate_timestamp IS NULL
    ) OR (
      origin_country <> destination_country
      AND exchange_rate_id IS NOT NULL
      AND fx_rate > 0
      AND btrim(fx_rate_source) <> ''
      AND fx_rate_timestamp IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION konektag.validate_gift_fx_evidence()
RETURNS trigger AS $$
DECLARE
  evidence konektag.exchange_rates%ROWTYPE;
BEGIN
  IF NEW.origin_country = NEW.destination_country THEN
    RETURN NEW;
  END IF;

  SELECT * INTO evidence
  FROM konektag.exchange_rates
  WHERE id = NEW.exchange_rate_id;

  IF NOT FOUND
     OR evidence.from_currency <> NEW.source_currency
     OR evidence.to_currency <> NEW.destination_currency
     OR evidence.rate <> NEW.fx_rate
     OR evidence.rate_source IS DISTINCT FROM NEW.fx_rate_source
     OR COALESCE(evidence.published_at, evidence.valid_from) <> NEW.fx_rate_timestamp THEN
    RAISE EXCEPTION 'GIFT_FX_EVIDENCE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_gift_fx_evidence ON konektag.gift_intents;
CREATE TRIGGER trg_validate_gift_fx_evidence
  BEFORE INSERT OR UPDATE OF origin_country, destination_country, source_currency,
    destination_currency, exchange_rate_id, fx_rate, fx_rate_source, fx_rate_timestamp
  ON konektag.gift_intents
  FOR EACH ROW EXECUTE FUNCTION konektag.validate_gift_fx_evidence();

COMMIT;
