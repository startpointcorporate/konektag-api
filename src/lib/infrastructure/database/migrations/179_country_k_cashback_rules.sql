BEGIN;

-- Cashback earned from K consumption is a fee credit for a future K acquisition.
-- payment_country is the authoritative country already resolved by PaymentContext; never re-derive it here.
-- It is never K balance and is never earned from an external corridor.
CREATE TABLE konektag.payment_country_k_cashback_rules (
  payment_country VARCHAR(5) NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('qr','payment_link')),
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('APPROVED','SUSPENDED','EXPIRED')),
  frappe_reference TEXT NOT NULL,
  PRIMARY KEY(payment_country,rail,valid_from),
  CHECK(valid_until IS NULL OR valid_until > valid_from)
);

ALTER TABLE konektag.points_merchant_consumptions
  ADD COLUMN payment_country VARCHAR(5),
  ADD COLUMN payment_rail TEXT,
  ADD COLUMN cashback_rate_bps INTEGER,
  ADD CONSTRAINT points_consumption_cashback_rail
    CHECK(payment_rail IS NULL OR payment_rail IN ('qr','payment_link','internal','other')),
  ADD CONSTRAINT points_consumption_cashback_rate
    CHECK(cashback_rate_bps IS NULL OR cashback_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT points_consumption_cashback_scope
    CHECK(cashback_rate_bps IS NULL OR (payment_country IS NOT NULL AND payment_rail IN ('qr','payment_link')));

-- The monetary cashback base is the proven value of the K portion only. Migration 136
-- already derives merchant_value as least(K quantity, commercial amount); keep that
-- immutable evidence and never use the order total as a cashback base.

-- Migration 136 fixed the historical pilot rate at 0.25%. Runtime rates are now
-- snapshotted from approved country configuration.
ALTER TABLE konektag.fee_credits DROP CONSTRAINT IF EXISTS fee_credits_rate_check;
ALTER TABLE konektag.fee_credits
  ADD CONSTRAINT fee_credits_rate_check CHECK(rate >= 0 AND rate <= 1);

CREATE OR REPLACE FUNCTION konektag.guard_points_benefit_identity()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='fee_credits' THEN
      IF ROW(NEW.consumption_id,NEW.party_id,NEW.currency,NEW.rate,NEW.initial_amount,NEW.idempotency_key,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.consumption_id,OLD.party_id,OLD.currency,OLD.rate,OLD.initial_amount,OLD.idempotency_key,OLD.created_at)
      THEN RAISE EXCEPTION 'FEE_CREDIT_IDENTITY_IMMUTABLE'; END IF;
    ELSE
      IF ROW(NEW.consumption_id,NEW.merchant_profile_id,NEW.legal_entity_id,NEW.currency,NEW.rate,NEW.amount,NEW.expense_role,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.consumption_id,OLD.merchant_profile_id,OLD.legal_entity_id,OLD.currency,OLD.rate,OLD.amount,OLD.expense_role,OLD.created_at)
      THEN RAISE EXCEPTION 'MERCHANT_BONUS_IDENTITY_IMMUTABLE'; END IF;
    END IF;
  END IF;
  SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=NEW.consumption_id;
  IF NOT c.eligible OR c.currency<>NEW.currency THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  IF TG_TABLE_NAME='fee_credits' THEN
    IF c.payment_rail NOT IN ('qr','payment_link') OR c.cashback_rate_bps IS NULL
      OR NEW.party_id<>c.party_id
      OR NEW.rate<>c.cashback_rate_bps::numeric/10000
      OR NEW.initial_amount<>c.merchant_value*c.cashback_rate_bps::numeric/10000
    THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
  ELSE
    IF NEW.merchant_profile_id<>c.merchant_profile_id OR NEW.legal_entity_id<>c.legal_entity_id OR NEW.amount<>c.merchant_value*0.01
    THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
