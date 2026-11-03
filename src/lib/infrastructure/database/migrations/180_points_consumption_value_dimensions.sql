BEGIN;

-- Value basis version 2 separates the dimensions of a Points K consumption:
--   quantity                  Points K actually consumed (quantity_k_consumed)
--   transaction_amount_minor  commercial amount of the sale, in transaction_currency minor units
--   k_value_amount            monetary value of the consumed K, snapshotted from the official
--                             parity identified by k_valuation_version (k_value_currency = EUR)
--   cashback_amount           cashback_rate_bps applied to k_value_amount only (cashback_currency = EUR)
-- The cashback base is never the transaction amount. payment_valuation_proof_hash records the
-- official valuation that produced the consumed quantity when one exists (QR, Link Pay, offline).
-- In version 2, merchant_value is kept only as a mirror of k_value_amount for the migration 138
-- refund functions; no version 2 rule compares it with a quantity or a transaction amount, and
-- the benefit guards below read the dimensioned columns. Version 1 rows are historical evidence
-- and are not rewritten.
ALTER TABLE konektag.points_merchant_consumptions
  ADD COLUMN value_basis_version SMALLINT NOT NULL DEFAULT 1 CHECK (value_basis_version IN (1, 2)),
  ADD COLUMN transaction_amount_minor BIGINT CHECK (transaction_amount_minor > 0),
  ADD COLUMN transaction_currency VARCHAR(3) CHECK (transaction_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN k_value_amount NUMERIC(24,8) CHECK (k_value_amount > 0),
  ADD COLUMN k_value_currency VARCHAR(3) CHECK (k_value_currency = 'EUR'),
  ADD COLUMN k_valuation_version TEXT CHECK (length(k_valuation_version) > 0),
  ADD COLUMN payment_valuation_proof_hash TEXT CHECK (payment_valuation_proof_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN cashback_amount NUMERIC(24,8) CHECK (cashback_amount >= 0),
  ADD COLUMN cashback_currency VARCHAR(3) CHECK (cashback_currency = 'EUR'),
  ADD CONSTRAINT points_consumption_value_dimensions CHECK (value_basis_version = 1 OR (
    transaction_amount_minor IS NOT NULL AND transaction_currency IS NOT NULL
    AND k_value_amount IS NOT NULL AND k_value_currency IS NOT NULL AND k_valuation_version IS NOT NULL
    AND currency = k_value_currency AND merchant_value = k_value_amount)),
  ADD CONSTRAINT points_consumption_cashback_amount CHECK (value_basis_version = 1 OR (
    (cashback_rate_bps IS NULL AND cashback_amount IS NULL AND cashback_currency IS NULL)
    OR (cashback_rate_bps IS NOT NULL AND cashback_currency = k_value_currency
        AND cashback_amount = k_value_amount * cashback_rate_bps::numeric / 10000)));

-- The migration 136 comparison merchant_value <= quantity mixes a monetary value with a K
-- quantity; it now governs only the historical version 1 rows.
-- The 136 constraint is unnamed; it is identified by its definition, never by a generated name.
DO $$
DECLARE v_names TEXT[];
BEGIN
  SELECT array_agg(conname) INTO v_names FROM pg_constraint
  WHERE conrelid='konektag.points_merchant_consumptions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) ~ 'merchant_value <= \(?quantity\)?';
  IF coalesce(array_length(v_names,1),0) <> 1 THEN
    RAISE EXCEPTION 'POINTS_MERCHANT_VALUE_CHECK_NOT_UNIQUE: %', v_names;
  END IF;
  EXECUTE format('ALTER TABLE konektag.points_merchant_consumptions DROP CONSTRAINT %I', v_names[1]);
END $$;
ALTER TABLE konektag.points_merchant_consumptions
  ADD CONSTRAINT points_consumption_merchant_value CHECK (merchant_value >= 0
    AND (value_basis_version <> 1 OR merchant_value <= quantity));

-- Every consumption recorded from now on uses the explicit dimensions.
ALTER TABLE konektag.points_merchant_consumptions ALTER COLUMN value_basis_version SET DEFAULT 2;

CREATE OR REPLACE FUNCTION konektag.check_points_consumption_completion()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE; v_good BOOLEAN; v_base NUMERIC;
BEGIN
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=NEW.id;
 SELECT count(*)=2 AND bool_and(e.currency='K' AND e.gl_scope='GLOBAL_USER_GL' AND e.amount=c.quantity
   AND ((e.account_code='1000' AND e.entry_side='debit' AND e.party_id=c.party_id)
     OR(e.account_code='K_ISSUANCE' AND e.entry_side='credit' AND e.party_id IS NULL))) INTO v_good
 FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id=e.transaction_id
 WHERE t.id=c.k_transaction_id AND t.status='completed' AND t.currency='K';
 IF v_good IS DISTINCT FROM TRUE OR NOT EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations r
   WHERE r.id=c.reservation_id AND r.payer_party_id=c.party_id AND r.amount=c.quantity AND r.currency='K'
     AND r.lifecycle='captured' AND r.consumption_transaction_id=c.k_transaction_id)
 THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
 IF c.value_basis_version = 2 THEN
  -- The commercial transaction is the merchant sale of the same monetary transaction.
  IF NOT EXISTS(SELECT 1 FROM konektag.merchant_sales s
    WHERE s.transaction_id=c.monetary_transaction_id AND s.merchant_profile_id=c.merchant_profile_id
      AND s.legal_entity_id=c.legal_entity_id AND s.currency=c.transaction_currency
      AND s.gross_amount=c.transaction_amount_minor)
  THEN RAISE EXCEPTION 'POINTS_TRANSACTION_MISMATCH'; END IF;
  -- The fee credit exists exactly when a cashback amount was granted on the K value.
  IF c.cashback_amount IS NOT NULL THEN
   IF NOT c.eligible OR (SELECT count(*) FROM konektag.fee_credits WHERE consumption_id=c.id)<>1
   THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
  ELSIF EXISTS(SELECT 1 FROM konektag.fee_credits WHERE consumption_id=c.id)
  THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  -- The merchant bonus follows the merchant eligibility (migration 136), independently of the cashback.
  IF c.eligible THEN
   IF (SELECT count(*) FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)<>1
    OR (SELECT count(*) FROM konektag.outbox_events WHERE aggregate_id=c.id AND event_type='PointsMerchantBonusProjectionRequested')<>1
   THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
  ELSIF EXISTS(SELECT 1 FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)
  THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  RETURN NULL;
 END IF;
 -- Version 1: historical migration 136 rules, unchanged.
 SELECT least(c.quantity,COALESCE(o.subtotal_amount,s.gross_amount)) INTO v_base
 FROM konektag.merchant_sales s JOIN konektag.api_payment_wallet_reservations r ON r.id=c.reservation_id
 LEFT JOIN konektag.api_payment_orders o ON o.id=r.payment_order_id
 WHERE s.transaction_id=c.monetary_transaction_id AND s.merchant_profile_id=c.merchant_profile_id
   AND s.legal_entity_id=c.legal_entity_id AND s.currency=c.currency;
 IF v_base IS NULL OR v_base<>c.merchant_value THEN RAISE EXCEPTION 'POINTS_MERCHANT_VALUE_MISMATCH'; END IF;
 IF c.eligible THEN
  IF (SELECT count(*) FROM konektag.fee_credits WHERE consumption_id=c.id)<>1
   OR (SELECT count(*) FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)<>1
   OR (SELECT count(*) FROM konektag.outbox_events WHERE aggregate_id=c.id AND event_type='PointsMerchantBonusProjectionRequested')<>1
  THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
 ELSIF EXISTS(SELECT 1 FROM konektag.fee_credits WHERE consumption_id=c.id)
   OR EXISTS(SELECT 1 FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)
 THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
 RETURN NULL;
END; $$;

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
  IF c.value_basis_version = 2 THEN
    -- The fee credit is the granted cashback; the merchant bonus is valued on the K value
    -- and does not depend on the cashback.
    IF TG_TABLE_NAME='fee_credits' THEN
      IF c.payment_rail NOT IN ('qr','payment_link') OR c.cashback_amount IS NULL
        OR NEW.party_id<>c.party_id OR NEW.currency<>c.cashback_currency
        OR NEW.rate<>c.cashback_rate_bps::numeric/10000
        OR NEW.initial_amount<>c.cashback_amount
      THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
    ELSE
      IF NEW.merchant_profile_id<>c.merchant_profile_id
        OR NEW.legal_entity_id<>c.legal_entity_id OR NEW.currency<>c.k_value_currency
        OR NEW.amount<>c.k_value_amount*0.01
      THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Version 1: migration 179 rules, unchanged.
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
