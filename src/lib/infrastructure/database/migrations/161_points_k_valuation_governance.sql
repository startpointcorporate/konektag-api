BEGIN;

-- Points K authority is layered on the existing FX table. Historical FX rows
-- remain unchanged and are DRAFT until explicitly approved for Points K.
ALTER TABLE konektag.exchange_rates
  ADD COLUMN IF NOT EXISTS points_k_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS points_k_matrix_version INTEGER,
  ADD COLUMN IF NOT EXISTS points_k_approved_by UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS points_k_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS points_k_approval_source VARCHAR(160),
  ADD COLUMN IF NOT EXISTS points_k_change_reason TEXT,
  ADD COLUMN IF NOT EXISTS points_k_updated_by UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS points_k_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE konektag.exchange_rates
  ADD CONSTRAINT exchange_rates_points_k_status_ck
    CHECK (points_k_status IN ('DRAFT', 'APPROVED', 'REVOKED')),
  ADD CONSTRAINT exchange_rates_points_k_period_ck
    CHECK (valid_to > valid_from),
  ADD CONSTRAINT exchange_rates_points_k_approval_ck
    CHECK (points_k_status = 'DRAFT' OR (
      points_k_matrix_version IS NOT NULL AND points_k_matrix_version > 0
      AND points_k_approved_at IS NOT NULL
      AND points_k_approval_source IS NOT NULL
      AND btrim(points_k_approval_source) <> ''
    ));

-- 1 EUR = 1 K is a fixed business rule confirmed by the PK_EUR lots. It is
-- represented as an explicit authority row so every valuation has a proof.
INSERT INTO konektag.exchange_rates
  (from_currency, to_currency, rate, valid_from, valid_to,
   points_k_status, points_k_matrix_version, points_k_approved_at,
   points_k_approval_source, points_k_change_reason)
SELECT 'EUR', 'EUR', 1, now(), '9999-12-31',
       'APPROVED', 1, now(), 'POINTS_K_FIXED_PARITY', '1 EUR = 1 K'
WHERE NOT EXISTS (
  SELECT 1 FROM konektag.exchange_rates
  WHERE from_currency = 'EUR' AND to_currency = 'EUR'
    AND points_k_status = 'APPROVED'
);

CREATE OR REPLACE FUNCTION konektag.guard_points_k_rate_governance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'points-k-rate:' || NEW.from_currency || ':' || NEW.to_currency, 0));

  IF TG_OP = 'UPDATE' AND OLD.points_k_status IN ('APPROVED', 'REVOKED') AND (
    NEW.from_currency IS DISTINCT FROM OLD.from_currency OR
    NEW.to_currency IS DISTINCT FROM OLD.to_currency OR
    NEW.rate IS DISTINCT FROM OLD.rate OR
    NEW.valid_from IS DISTINCT FROM OLD.valid_from OR
    NEW.valid_to IS DISTINCT FROM OLD.valid_to OR
    NEW.points_k_matrix_version IS DISTINCT FROM OLD.points_k_matrix_version OR
    NEW.points_k_approval_source IS DISTINCT FROM OLD.points_k_approval_source
  ) THEN
    RAISE EXCEPTION 'POINTS_K_RATE_VERSION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.points_k_status = 'REVOKED'
     AND NEW.points_k_status IS DISTINCT FROM 'REVOKED' THEN
    RAISE EXCEPTION 'POINTS_K_RATE_REVOKED_IMMUTABLE';
  END IF;

  IF NEW.points_k_status = 'APPROVED' THEN
    SELECT id INTO conflict_id
    FROM konektag.exchange_rates r
    WHERE r.id <> NEW.id
      AND r.from_currency = NEW.from_currency
      AND r.to_currency = NEW.to_currency
      AND r.points_k_status = 'APPROVED'
      AND tstzrange(r.valid_from, r.valid_to, '[)') &&
          tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    LIMIT 1;
    IF conflict_id IS NOT NULL THEN
      RAISE EXCEPTION 'POINTS_K_APPROVED_RATE_PERIOD_CONFLICT';
    END IF;
  END IF;
  NEW.points_k_updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS exchange_rates_points_k_governance
  ON konektag.exchange_rates;
CREATE TRIGGER exchange_rates_points_k_governance
  BEFORE INSERT OR UPDATE ON konektag.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_k_rate_governance();

CREATE INDEX IF NOT EXISTS exchange_rates_points_k_lookup
  ON konektag.exchange_rates(from_currency, to_currency, points_k_status, valid_from, valid_to,
    points_k_matrix_version DESC);

COMMIT;
