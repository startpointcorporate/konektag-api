BEGIN;

-- 149 stored the original currency/amount but no historical FX decision. Existing
-- EUR rows have a provable 1:1 conversion. Non-EUR rows cannot be backfilled from
-- exchange_rates: those rows may represent a current rate, not the historical rate.
-- Introduce nullable fields, classify historical rows, then enforce full reference
-- evidence for every new row and every VERIFIED row.
ALTER TABLE konektag.core_offline_authorizations
  ADD COLUMN reference_currency VARCHAR(3),
  ADD COLUMN reference_rate NUMERIC(21,9),
  ADD COLUMN reference_rate_id UUID REFERENCES konektag.exchange_rates(id),
  ADD COLUMN reference_rate_inverse BOOLEAN,
  ADD COLUMN reference_converted_at TIMESTAMPTZ,
  ADD COLUMN reference_source TEXT,
  ADD COLUMN reference_status TEXT;

ALTER TABLE konektag.core_transaction_offline
  ADD COLUMN reference_amount_minor BIGINT,
  ADD COLUMN reference_currency VARCHAR(3),
  ADD COLUMN reference_rate NUMERIC(21,9),
  ADD COLUMN reference_rate_id UUID REFERENCES konektag.exchange_rates(id),
  ADD COLUMN reference_rate_inverse BOOLEAN,
  ADD COLUMN reference_converted_at TIMESTAMPTZ,
  ADD COLUMN reference_source TEXT,
  ADD COLUMN reference_status TEXT;

-- Inspect the original transaction and authorization data. EUR needs no FX rate.
-- The authorization decision time is the only defensible historical timestamp.
UPDATE konektag.core_offline_authorizations
SET reference_currency='EUR', reference_rate=1, reference_rate_inverse=false,
    reference_converted_at=starts_at, reference_source='EUR_PARITY',
    reference_status='VERIFIED'
WHERE currency='EUR' AND maximum_total_minor=total_eur_equivalent_minor
  AND maximum_single_minor=single_eur_equivalent_minor;

-- Existing non-EUR decisions and inconsistent EUR decisions require FX review.
-- Keep the original server decision: reference_status alone blocks new evidence.
UPDATE konektag.core_offline_authorizations
SET reference_status='REQUIRES_REVIEW'
WHERE reference_status IS NULL;

UPDATE konektag.core_transaction_offline o
SET reference_amount_minor=t.total_minor, reference_currency='EUR',
    reference_rate=1, reference_rate_inverse=false,
    reference_converted_at=a.starts_at, reference_source='EUR_PARITY',
    reference_status='VERIFIED'
FROM konektag.core_transactions t, konektag.core_offline_authorizations a
WHERE o.transaction_id=t.id AND o.authorization_id=a.id
  AND a.reference_status='VERIFIED' AND t.currency='EUR';

-- Quarantine only the FX reference. A historical SETTLED outcome remains SETTLED
-- (and retains its settled-counter uniqueness); REJECTED also remains terminal.
-- Pending rows await arbitration without an invented exchange-rate decision.
UPDATE konektag.core_transaction_offline o
SET reference_status='REQUIRES_REVIEW',
    sync_state=CASE WHEN sync_state IN ('SETTLED','REJECTED') THEN sync_state ELSE 'REQUIRES_REVIEW' END,
    conflict_reason=CASE WHEN sync_state='SETTLED' OR conflict_reason IS NOT NULL THEN conflict_reason
                         ELSE 'LEGACY_REFERENCE_UNVERIFIED' END
WHERE reference_status IS NULL;

ALTER TABLE konektag.core_offline_authorizations
  ALTER COLUMN reference_status SET NOT NULL,
  ADD CONSTRAINT ck_core_offline_authorization_reference CHECK (
    (reference_status='REQUIRES_REVIEW'
      AND reference_currency IS NULL AND reference_rate IS NULL
      AND reference_rate_id IS NULL AND reference_rate_inverse IS NULL
      AND reference_converted_at IS NULL AND reference_source IS NULL)
    OR (reference_status='VERIFIED' AND reference_currency='EUR'
      AND reference_rate IS NOT NULL AND reference_rate>0 AND reference_currency IS NOT NULL AND reference_rate_inverse IS NOT NULL
      AND reference_converted_at IS NOT NULL AND reference_source IS NOT NULL
      AND ((currency='EUR' AND reference_rate=1 AND reference_rate_id IS NULL
            AND NOT reference_rate_inverse AND reference_source='EUR_PARITY')
        OR (currency<>'EUR' AND reference_rate_id IS NOT NULL
            AND reference_source='SERVER_RATE')))
  );

ALTER TABLE konektag.core_transaction_offline
  ALTER COLUMN reference_status SET NOT NULL,
  ADD CONSTRAINT ck_core_offline_evidence_reference CHECK (
    (reference_status='REQUIRES_REVIEW'
      AND reference_amount_minor IS NULL AND reference_currency IS NULL
      AND reference_rate IS NULL AND reference_rate_id IS NULL
      AND reference_rate_inverse IS NULL AND reference_converted_at IS NULL
      AND reference_source IS NULL)
    OR (reference_status='VERIFIED' AND reference_amount_minor IS NOT NULL AND reference_amount_minor>=0
      AND reference_currency='EUR' AND reference_rate IS NOT NULL AND reference_rate>0
      AND reference_rate_inverse IS NOT NULL AND reference_converted_at IS NOT NULL
      AND reference_source IS NOT NULL
      AND ((reference_rate=1 AND reference_rate_id IS NULL
            AND NOT reference_rate_inverse AND reference_source='EUR_PARITY')
        OR (reference_rate_id IS NOT NULL AND reference_source='SERVER_RATE')))
  );

-- Historical review rows are the only permitted nullable reference rows.
CREATE FUNCTION konektag.core_require_new_offline_evidence_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference_status IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'new offline evidence requires verified reference';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_require_new_offline_evidence_reference BEFORE INSERT
  ON konektag.core_transaction_offline FOR EACH ROW
  EXECUTE FUNCTION konektag.core_require_new_offline_evidence_reference();

-- Canonical conversion shared by the service and evidence trigger. Rates are
-- stored with nine decimal places: n = rate * 10^9. For source minor units x,
-- scale = 10^source minor digits and EUR has 100 minor units:
-- direct: floor((x*100*n + floor(scale*10^9/2))/(scale*10^9));
-- inverse: floor((x*100*10^9 + floor(scale*n/2))/(scale*n)).
-- This is positive half-up rounding, identical to money-unit.ts convertMinor.
CREATE FUNCTION konektag.core_convert_to_eur_minor(
  original_minor BIGINT, original_currency VARCHAR(3), frozen_rate NUMERIC,
  inverse BOOLEAN
) RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits INTEGER;
  numerator NUMERIC;
  denominator NUMERIC;
  rate_numerator NUMERIC;
  rounded NUMERIC;
BEGIN
  digits := CASE original_currency
    WHEN 'EUR' THEN 2 WHEN 'XOF' THEN 0 WHEN 'XAF' THEN 0
    WHEN 'AOA' THEN 2 WHEN 'CDF' THEN 2 WHEN 'GNF' THEN 0
    ELSE NULL END;
  IF digits IS NULL OR original_minor IS NULL OR original_minor < 0
     OR frozen_rate IS NULL OR frozen_rate <= 0 OR inverse IS NULL THEN
    RAISE EXCEPTION 'invalid offline EUR conversion input';
  END IF;
  rate_numerator := frozen_rate * 1000000000::numeric;
  IF rate_numerator <> trunc(rate_numerator) THEN
    RAISE EXCEPTION 'offline EUR rate precision exceeds nine places';
  END IF;
  IF inverse THEN
    numerator := original_minor::numeric * 100 * 1000000000;
    denominator := power(10::numeric, digits) * rate_numerator;
  ELSE
    numerator := original_minor::numeric * 100 * rate_numerator;
    denominator := power(10::numeric, digits) * 1000000000;
  END IF;
  IF denominator <= 0 THEN RAISE EXCEPTION 'invalid offline EUR conversion denominator'; END IF;
  rounded := floor((numerator + floor(denominator / 2)) / denominator);
  IF rounded > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'offline EUR amount exceeds BIGINT';
  END IF;
  RETURN rounded::bigint;
END $$;

-- A VERIFIED authorization must be reproducible from the referenced rate row.
-- The same conversion function prices limits, evidence and service decisions.
CREATE FUNCTION konektag.core_require_new_offline_authorization_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_rate konektag.exchange_rates%ROWTYPE;
BEGIN
  IF NEW.reference_status IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'new offline authorization requires verified reference';
  END IF;
  -- The decision instant is PostgreSQL's transaction timestamp, irrespective of
  -- caller-supplied timestamps. The service selects its rate with the same now().
  NEW.starts_at := now();
  NEW.reference_converted_at := NEW.starts_at;
  IF NEW.currency<>'EUR' THEN
    SELECT * INTO frozen_rate FROM konektag.exchange_rates
      WHERE id=NEW.reference_rate_id FOR SHARE;
    IF NOT FOUND OR frozen_rate.rate IS DISTINCT FROM NEW.reference_rate
       OR (frozen_rate.valid_from<=NEW.reference_converted_at
           AND frozen_rate.valid_to>NEW.reference_converted_at) IS DISTINCT FROM true
       OR (NEW.reference_rate_inverse=false AND
           (frozen_rate.from_currency<>NEW.currency OR frozen_rate.to_currency<>NEW.reference_currency))
       OR (NEW.reference_rate_inverse=true AND
           (frozen_rate.from_currency<>NEW.reference_currency OR frozen_rate.to_currency<>NEW.currency)) THEN
      RAISE EXCEPTION 'offline authorization rate evidence mismatch';
    END IF;
  END IF;
  IF NEW.total_eur_equivalent_minor IS DISTINCT FROM konektag.core_convert_to_eur_minor(
       NEW.maximum_total_minor, NEW.currency, NEW.reference_rate, NEW.reference_rate_inverse)
     OR NEW.single_eur_equivalent_minor IS DISTINCT FROM konektag.core_convert_to_eur_minor(
       NEW.maximum_single_minor, NEW.currency, NEW.reference_rate, NEW.reference_rate_inverse) THEN
    RAISE EXCEPTION 'offline authorization EUR limits mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_require_new_offline_authorization_reference BEFORE INSERT
  ON konektag.core_offline_authorizations FOR EACH ROW
  EXECUTE FUNCTION konektag.core_require_new_offline_authorization_reference();

CREATE FUNCTION konektag.core_block_unverified_offline_settlement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.reference_status='VERIFIED' THEN
    -- Evidence uses the frozen authorization decision, never an importer clock.
    NEW.reference_converted_at := (SELECT a.reference_converted_at
      FROM konektag.core_offline_authorizations a WHERE a.id=NEW.authorization_id);
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.sync_state='SETTLED' AND NEW.sync_state IS DISTINCT FROM 'SETTLED' THEN
      RAISE EXCEPTION 'settled offline outcome is immutable';
    END IF;
    IF OLD.sync_state='REJECTED' AND NEW.sync_state IS DISTINCT FROM 'REJECTED' THEN
      RAISE EXCEPTION 'rejected offline outcome is immutable';
    END IF;
    IF OLD.reference_status='REQUIRES_REVIEW' AND
       ((OLD.sync_state='REQUIRES_REVIEW' AND NEW.sync_state NOT IN ('REQUIRES_REVIEW','REJECTED'))
        OR (OLD.sync_state='REJECTED' AND NEW.sync_state IS DISTINCT FROM 'REJECTED')) THEN
      RAISE EXCEPTION 'legacy offline review requires terminal rejection';
    END IF;
  END IF;
  IF NEW.reference_status='VERIFIED' AND NOT EXISTS (
       SELECT 1 FROM konektag.core_offline_authorizations a
       JOIN konektag.core_transactions t ON t.id=NEW.transaction_id
       WHERE a.id=NEW.authorization_id AND a.reference_status='VERIFIED'
         AND NEW.reference_currency='EUR'
         AND NEW.reference_rate=a.reference_rate
         AND NEW.reference_rate_id IS NOT DISTINCT FROM a.reference_rate_id
         AND NEW.reference_rate_inverse=a.reference_rate_inverse
         AND NEW.reference_source=a.reference_source
         AND NEW.reference_amount_minor=konektag.core_convert_to_eur_minor(
           t.total_minor, t.currency, a.reference_rate, a.reference_rate_inverse)
         AND ((t.currency='EUR' AND a.currency='EUR' AND NEW.reference_source='EUR_PARITY')
           OR (t.currency<>'EUR' AND a.currency=t.currency AND NEW.reference_source='SERVER_RATE'))
       FOR SHARE OF a, t
     ) THEN
    RAISE EXCEPTION 'offline reference amount or source mismatch';
  END IF;
  IF NEW.sync_state='SETTLED' AND NEW.reference_status IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'offline settlement requires verified EUR reference';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_block_unverified_offline_settlement BEFORE INSERT OR UPDATE
  ON konektag.core_transaction_offline FOR EACH ROW
  EXECUTE FUNCTION konektag.core_block_unverified_offline_settlement();

-- All inserts, including direct SQL imports, share this single cap decision.
-- Locking the device serializes competing inserts before any usage is counted.
CREATE FUNCTION konektag.core_validate_offline_evidence_limits()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  auth_row RECORD;
  original_minor BIGINT;
  pending_count BIGINT;
  native_total NUMERIC;
  eur_total NUMERIC;
BEGIN
  PERFORM 1 FROM konektag.core_offline_devices
    WHERE id=NEW.device_id AND state='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFLINE_DEVICE_DENIED'; END IF;
  SELECT a.* INTO auth_row FROM konektag.core_offline_authorizations a
    WHERE a.id=NEW.authorization_id AND a.device_id=NEW.device_id
      AND a.server_decision='APPROVED' AND a.reference_status='VERIFIED'
      AND a.starts_at<=now() AND a.expires_at>now() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFLINE_AUTHORIZATION_DENIED'; END IF;
  SELECT t.total_minor INTO original_minor FROM konektag.core_transactions t
    JOIN konektag.core_offline_authorizations a ON a.id=NEW.authorization_id
    WHERE t.id=NEW.transaction_id AND t.currency=a.currency
      AND t.customer_user_id=auth_row.owner_user_id FOR SHARE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline transaction owner or currency mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM konektag.core_transaction_offline o
      JOIN konektag.core_offline_authorizations a ON a.id=o.authorization_id
      WHERE a.owner_user_id=auth_row.owner_user_id AND o.reference_status<>'VERIFIED'
        AND o.sync_state<>'REJECTED') THEN
    RAISE EXCEPTION 'OFFLINE_REFERENCE_REQUIRES_REVIEW';
  END IF;
  IF original_minor>auth_row.maximum_single_minor
     OR NEW.reference_amount_minor>auth_row.single_eur_equivalent_minor THEN
    RAISE EXCEPTION 'OFFLINE_SINGLE_LIMIT';
  END IF;
  SELECT COUNT(*) FILTER (WHERE o.sync_state NOT IN ('SETTLED','REJECTED')),
    COALESCE(SUM(t.total_minor) FILTER (WHERE o.authorization_id=NEW.authorization_id
      AND o.sync_state NOT IN ('SETTLED','REJECTED')),0),
    COALESCE(SUM(o.reference_amount_minor) FILTER (WHERE o.sync_state NOT IN ('SETTLED','REJECTED')),0)
  INTO pending_count,native_total,eur_total
  FROM konektag.core_transaction_offline o
  JOIN konektag.core_offline_authorizations a ON a.id=o.authorization_id
  JOIN konektag.core_transactions t ON t.id=o.transaction_id
  WHERE a.owner_user_id=auth_row.owner_user_id;
  IF pending_count>=auth_row.maximum_count THEN RAISE EXCEPTION 'OFFLINE_COUNT_LIMIT'; END IF;
  IF native_total+original_minor>auth_row.maximum_total_minor
     OR eur_total+NEW.reference_amount_minor>auth_row.total_eur_equivalent_minor THEN
    RAISE EXCEPTION 'OFFLINE_TOTAL_LIMIT';
  END IF;
  RETURN NEW;
END $$;
-- Run this lock acquisition before the reference/owner guards, which take share
-- locks on authorization and transaction rows, to keep a consistent lock order.
CREATE TRIGGER core_a_validate_offline_evidence_limits BEFORE INSERT
  ON konektag.core_transaction_offline FOR EACH ROW
  EXECUTE FUNCTION konektag.core_validate_offline_evidence_limits();

CREATE FUNCTION konektag.core_protect_offline_transaction_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.currency IS DISTINCT FROM OLD.currency)
     AND EXISTS (SELECT 1 FROM konektag.core_transaction_offline o WHERE o.transaction_id=OLD.id) THEN
    RAISE EXCEPTION 'canonical amount is immutable after offline evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_protect_offline_transaction_amount BEFORE UPDATE OF total_minor,currency
  ON konektag.core_transactions FOR EACH ROW
  EXECUTE FUNCTION konektag.core_protect_offline_transaction_amount();

CREATE FUNCTION konektag.core_protect_offline_authorization_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.maximum_total_minor IS DISTINCT FROM OLD.maximum_total_minor
     OR NEW.maximum_single_minor IS DISTINCT FROM OLD.maximum_single_minor
     OR NEW.total_eur_equivalent_minor IS DISTINCT FROM OLD.total_eur_equivalent_minor
     OR NEW.single_eur_equivalent_minor IS DISTINCT FROM OLD.single_eur_equivalent_minor
     OR NEW.reference_currency IS DISTINCT FROM OLD.reference_currency
     OR NEW.reference_rate IS DISTINCT FROM OLD.reference_rate
     OR NEW.reference_rate_id IS DISTINCT FROM OLD.reference_rate_id
     OR NEW.reference_rate_inverse IS DISTINCT FROM OLD.reference_rate_inverse
     OR NEW.reference_converted_at IS DISTINCT FROM OLD.reference_converted_at
     OR NEW.reference_source IS DISTINCT FROM OLD.reference_source
     OR NEW.reference_status IS DISTINCT FROM OLD.reference_status THEN
    RAISE EXCEPTION 'offline authorization reference is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_protect_offline_authorization_reference BEFORE UPDATE
  ON konektag.core_offline_authorizations FOR EACH ROW
  EXECUTE FUNCTION konektag.core_protect_offline_authorization_reference();

CREATE OR REPLACE FUNCTION konektag.core_protect_offline_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.proofs IS DISTINCT FROM OLD.proofs OR NEW.envelope IS DISTINCT FROM OLD.envelope
     OR NEW.client_transaction_id IS DISTINCT FROM OLD.client_transaction_id
     OR NEW.local_counter IS DISTINCT FROM OLD.local_counter
     OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.reference_amount_minor IS DISTINCT FROM OLD.reference_amount_minor
     OR NEW.reference_currency IS DISTINCT FROM OLD.reference_currency
     OR NEW.reference_rate IS DISTINCT FROM OLD.reference_rate
     OR NEW.reference_rate_id IS DISTINCT FROM OLD.reference_rate_id
     OR NEW.reference_rate_inverse IS DISTINCT FROM OLD.reference_rate_inverse
     OR NEW.reference_converted_at IS DISTINCT FROM OLD.reference_converted_at
     OR NEW.reference_source IS DISTINCT FROM OLD.reference_source
     OR NEW.reference_status IS DISTINCT FROM OLD.reference_status THEN
    RAISE EXCEPTION 'offline evidence is immutable';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
