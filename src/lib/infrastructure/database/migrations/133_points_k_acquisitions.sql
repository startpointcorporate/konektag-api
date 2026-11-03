-- No historical balances are reclassified or repaired by this migration.
BEGIN;
ALTER TABLE konektag.financial_accounts ALTER COLUMN account_code TYPE VARCHAR(40);
ALTER TABLE konektag.ledger_entries ALTER COLUMN account_code TYPE VARCHAR(40);
INSERT INTO konektag.financial_accounts(account_code, account_name, account_type, is_system, is_cash, description)
VALUES ('K_ISSUANCE', 'Émission de Points K', 'equity', true, false, 'K only; system issuance counterpart'),
       ('K_ALLOCATION_CLEARING', 'Points K en attente d’affectation', 'asset', true, false, 'K only; zero after acquisition')
ON CONFLICT (account_code) DO NOTHING;

ALTER TABLE konektag.ledger_entries ALTER COLUMN amount TYPE NUMERIC(22,2);
ALTER TABLE konektag.api_payment_orders
  ADD COLUMN recharge_lot_id TEXT,
  ADD COLUMN recharge_request_key TEXT,
  ADD COLUMN points_quantity BIGINT CHECK(points_quantity>0),
  ADD COLUMN lot_value_minor BIGINT CHECK(lot_value_minor>0),
  ADD COLUMN psp_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK(psp_fee_minor>=0),
  ADD COLUMN charged_psp_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK(charged_psp_fee_minor>=0),
  ADD COLUMN konektag_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK(konektag_fee_minor>=0),
  ADD COLUMN recharge_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK(recharge_tax_minor>=0),
  ADD COLUMN total_payment_minor BIGINT CHECK(total_payment_minor>0),
  ADD COLUMN confirmed_payment_minor BIGINT CHECK(confirmed_payment_minor>0),
  ADD COLUMN recharge_fee_policy TEXT CHECK(recharge_fee_policy IN ('ABSORBED_BY_KONEKTAG','CHARGED_TO_CUSTOMER')),
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','failed','confirmed')),
  ADD COLUMN acquisition_status TEXT CHECK (acquisition_status IN ('pending','processing','failed','completed')),
  ADD COLUMN acquisition_error TEXT,
  ADD CONSTRAINT points_quote_total CHECK(recharge_lot_id IS NULL OR total_payment_minor IS NULL
    OR total_payment_minor=lot_value_minor+charged_psp_fee_minor+konektag_fee_minor+recharge_tax_minor),
  ADD CONSTRAINT points_fee_policy_amount CHECK(recharge_lot_id IS NULL OR recharge_fee_policy IS NULL
    OR (recharge_fee_policy='ABSORBED_BY_KONEKTAG' AND charged_psp_fee_minor=0)
    OR (recharge_fee_policy='CHARGED_TO_CUSTOMER' AND charged_psp_fee_minor=psp_fee_minor)),
  ADD CONSTRAINT points_confirmed_total CHECK(recharge_lot_id IS NULL OR confirmed_payment_minor IS NULL
    OR confirmed_payment_minor=total_payment_minor);
CREATE UNIQUE INDEX uq_recharge_request ON konektag.api_payment_orders(target_user_id, recharge_request_key)
  WHERE recharge_request_key IS NOT NULL;

CREATE TABLE konektag.points_lots (
  id TEXT PRIMARY KEY, currency VARCHAR(3) NOT NULL, value_minor BIGINT NOT NULL CHECK(value_minor > 0),
  quantity BIGINT NOT NULL CHECK(quantity > 0), active BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL CHECK(provider IN ('stripe','pawapay'))
);
INSERT INTO konektag.points_lots VALUES
 ('PK_EUR_15','EUR',1500,15,true,'stripe'), ('PK_EUR_25','EUR',2500,25,true,'stripe'),
 ('PK_EUR_50','EUR',5000,50,true,'stripe'), ('PK_EUR_100','EUR',10000,100,true,'stripe');
ALTER TABLE konektag.api_payment_orders ADD FOREIGN KEY(recharge_lot_id) REFERENCES konektag.points_lots(id);

-- Durable verified PSP inbox; only successful, validated server callbacks populate this table.
CREATE TABLE konektag.points_payment_confirmations (
  order_id UUID PRIMARY KEY REFERENCES konektag.api_payment_orders(id),
  event_id UUID NOT NULL REFERENCES konektag.payment_provider_events(id),
  attempt_id UUID NOT NULL UNIQUE REFERENCES konektag.payment_provider_attempts(id),
  provider TEXT NOT NULL, provider_reference TEXT NOT NULL,
  confirmed_minor BIGINT NOT NULL CHECK(confirmed_minor > 0), currency VARCHAR(3) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_at TIMESTAMPTZ,
  UNIQUE(provider, provider_reference)
);
CREATE TABLE konektag.points_acquisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES konektag.points_payment_confirmations(order_id),
  party_id UUID NOT NULL REFERENCES konektag.parties(id),
  lot_id TEXT NOT NULL REFERENCES konektag.points_lots(id), quantity BIGINT NOT NULL CHECK(quantity > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
  klot_id UUID UNIQUE REFERENCES konektag.klots(id), completed_at TIMESTAMPTZ
);
ALTER TABLE konektag.ledger_entries
  ADD COLUMN points_order_id UUID REFERENCES konektag.api_payment_orders(id),
  ADD COLUMN points_acquisition_id UUID REFERENCES konektag.points_acquisitions(id),
  ADD COLUMN points_lot_id TEXT REFERENCES konektag.points_lots(id),
  ADD COLUMN points_leg TEXT CHECK(points_leg IN ('issuance_debit','issuance_credit','allocation_debit','allocation_credit','consumption_debit','consumption_credit'));
CREATE UNIQUE INDEX uq_points_acquisition_leg ON konektag.ledger_entries(points_acquisition_id,points_leg)
 WHERE points_acquisition_id IS NOT NULL;

-- Preserve historical rows, enforce the unit boundary on all NEW entries.
CREATE FUNCTION konektag.points_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_code IN ('1000','K_ISSUANCE','K_ALLOCATION_CLEARING') THEN
   IF NEW.currency <> 'K' OR NEW.amount <> trunc(NEW.amount) OR NEW.amount <= 0 THEN
     RAISE EXCEPTION 'POINTS_ACCOUNT_REQUIRES_K_INTEGER';
   END IF;
   IF NEW.account_code = '1000' AND NEW.party_id IS NULL THEN RAISE EXCEPTION 'POINTS_OWNER_REQUIRED'; END IF;
   IF NEW.account_code <> '1000' AND NEW.party_id IS NOT NULL THEN RAISE EXCEPTION 'SYSTEM_POINTS_ACCOUNT_HAS_NO_USER'; END IF;
   IF NEW.transaction_id IS NULL THEN RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND currency='K') THEN
     RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRES_K';
   END IF;
   IF EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND status IN ('completed','reversed')) THEN
     RAISE EXCEPTION 'FINAL_POINTS_TRANSACTION_IMMUTABLE';
   END IF;
   NEW.gl_scope := 'GLOBAL_USER_GL';
   NEW.legacy_classification := NULL;
 ELSIF NEW.currency = 'K' THEN RAISE EXCEPTION 'MONETARY_ACCOUNT_REJECTS_K'; END IF;
 IF EXISTS(SELECT 1 FROM konektag.financial_transactions t WHERE t.id=NEW.transaction_id
   AND (t.currency='K' OR NEW.currency='K') AND t.currency<>NEW.currency) THEN
   RAISE EXCEPTION 'POINTS_TRANSACTION_UNIT_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
-- Runs after the existing scope derivation (alphabetic trigger order).
CREATE TRIGGER zz_points_entry_guard BEFORE INSERT ON konektag.ledger_entries
 FOR EACH ROW EXECUTE FUNCTION konektag.points_entry_guard();

CREATE FUNCTION konektag.check_points_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a konektag.points_acquisitions; n INTEGER; valid INTEGER; outbox_count INTEGER;
BEGIN
 SELECT * INTO a FROM konektag.points_acquisitions WHERE id = NEW.id;
 IF a.status <> 'completed' THEN RETURN NULL; END IF;
 SELECT count(*), count(*) FILTER(WHERE currency='K' AND amount=a.quantity
   AND points_order_id=a.order_id AND points_lot_id=a.lot_id AND transaction_id=a.transaction_id AND klot_id=a.klot_id
   AND ((points_leg='issuance_debit' AND account_code='K_ISSUANCE' AND entry_side='debit' AND party_id IS NULL)
     OR (points_leg='issuance_credit' AND account_code='K_ALLOCATION_CLEARING' AND entry_side='credit' AND party_id IS NULL)
     OR (points_leg='allocation_debit' AND account_code='K_ALLOCATION_CLEARING' AND entry_side='debit' AND party_id IS NULL)
     OR (points_leg='allocation_credit' AND account_code='1000' AND entry_side='credit' AND party_id=a.party_id)))
 INTO n,valid FROM konektag.ledger_entries WHERE points_acquisition_id=a.id;
 IF n<>4 OR valid<>4 OR a.klot_id IS NULL OR a.transaction_id IS NULL THEN RAISE EXCEPTION 'POINTS_ACQUISITION_UNBALANCED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.points_lots WHERE id=a.lot_id AND quantity=a.quantity) THEN RAISE EXCEPTION 'POINTS_LOT_QUANTITY_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.klots k JOIN konektag.points_lots l ON l.id=a.lot_id
   WHERE k.id=a.klot_id AND k.quantity_k=a.quantity AND k.economic_currency=l.currency
     AND k.economic_value=l.value_minor/100.0) THEN RAISE EXCEPTION 'POINTS_KLOT_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.points_payment_confirmations WHERE order_id=a.order_id AND applied_at IS NOT NULL) THEN RAISE EXCEPTION 'POINTS_PROOF_NOT_APPLIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.api_payment_orders WHERE id=a.order_id AND state='paid' AND acquisition_status='completed') THEN RAISE EXCEPTION 'POINTS_ORDER_NOT_FINALIZED'; END IF;
 SELECT count(*) INTO outbox_count FROM konektag.outbox_events WHERE aggregate_id=a.id AND event_type='PointsAcquisitionCompleted';
 IF outbox_count<>1 THEN RAISE EXCEPTION 'POINTS_OUTBOX_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER points_acquisition_complete AFTER INSERT OR UPDATE ON konektag.points_acquisitions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_points_acquisition();

CREATE FUNCTION konektag.protect_completed_points_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='completed' OR NEW.order_id<>OLD.order_id OR NEW.party_id<>OLD.party_id
  OR NEW.lot_id<>OLD.lot_id OR NEW.quantity<>OLD.quantity OR NEW.idempotency_key<>OLD.idempotency_key THEN
  RAISE EXCEPTION 'POINTS_ACQUISITION_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_acquisition_immutable BEFORE UPDATE ON konektag.points_acquisitions
 FOR EACH ROW EXECUTE FUNCTION konektag.protect_completed_points_acquisition();

CREATE FUNCTION konektag.points_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.recharge_lot_id IS NOT NULL THEN
  IF NEW.recharge_lot_id IS DISTINCT FROM OLD.recharge_lot_id OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
    OR NEW.recharge_request_key IS DISTINCT FROM OLD.recharge_request_key OR NEW.currency<>OLD.currency
    OR NEW.subtotal_amount<>OLD.subtotal_amount THEN RAISE EXCEPTION 'POINTS_ORDER_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.points_quantity IS DISTINCT FROM OLD.points_quantity OR NEW.lot_value_minor IS DISTINCT FROM OLD.lot_value_minor THEN
    RAISE EXCEPTION 'POINTS_ORDER_QUANTITY_IMMUTABLE';
  END IF;
  IF OLD.funding_state IN ('external_started','finalized') AND
    (NEW.order_metadata->'pointsQuote' IS DISTINCT FROM OLD.order_metadata->'pointsQuote'
     OR NEW.provider_expected_amount IS DISTINCT FROM OLD.provider_expected_amount
     OR NEW.psp_fee_minor<>OLD.psp_fee_minor OR NEW.charged_psp_fee_minor<>OLD.charged_psp_fee_minor
     OR NEW.total_payment_minor IS DISTINCT FROM OLD.total_payment_minor
     OR NEW.konektag_fee_minor<>OLD.konektag_fee_minor OR NEW.recharge_tax_minor<>OLD.recharge_tax_minor
     OR NEW.recharge_fee_policy IS DISTINCT FROM OLD.recharge_fee_policy) THEN RAISE EXCEPTION 'POINTS_QUOTE_FROZEN'; END IF;
  IF OLD.payment_status='confirmed' AND (NEW.confirmed_payment_minor IS DISTINCT FROM OLD.confirmed_payment_minor OR NEW.payment_status<>'confirmed' OR NEW.state IN ('failed','expired','cancelled')) THEN
    RAISE EXCEPTION 'CONFIRMED_POINTS_PAYMENT_CANNOT_BE_CANCELLED';
  END IF;
  IF NEW.state='paid' AND NEW.acquisition_status IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'POINTS_ACQUISITION_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_order_guard BEFORE UPDATE ON konektag.api_payment_orders FOR EACH ROW EXECUTE FUNCTION konektag.points_order_guard();

CREATE FUNCTION konektag.points_order_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recharge_lot_id IS NOT NULL AND (NEW.state='paid' OR NEW.acquisition_status='completed')
   AND NOT EXISTS(SELECT 1 FROM konektag.points_acquisitions a JOIN konektag.points_payment_confirmations p ON p.order_id=a.order_id
     WHERE a.order_id=NEW.id AND a.status='completed' AND p.applied_at IS NOT NULL
       AND p.confirmed_minor=NEW.confirmed_payment_minor AND p.currency=NEW.currency) THEN
   RAISE EXCEPTION 'POINTS_COMPLETED_ACQUISITION_REQUIRED';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER points_order_completed AFTER INSERT OR UPDATE ON konektag.api_payment_orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.points_order_completion_guard();

-- A confirmed receipt is evidence: retries may only stamp its local application.
CREATE FUNCTION konektag.points_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'applied_at') IS DISTINCT FROM (to_jsonb(OLD)-'applied_at')
   OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
   RAISE EXCEPTION 'POINTS_PAYMENT_PROOF_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_proof_immutable BEFORE UPDATE OR DELETE ON konektag.points_payment_confirmations
 FOR EACH ROW EXECUTE FUNCTION konektag.points_proof_immutable();
CREATE FUNCTION konektag.points_lot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.currency<>OLD.currency OR NEW.quantity<>OLD.quantity
   OR NEW.value_minor<>OLD.value_minor OR NEW.provider<>OLD.provider THEN RAISE EXCEPTION 'POINTS_LOT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_lot_immutable BEFORE UPDATE ON konektag.points_lots
 FOR EACH ROW EXECUTE FUNCTION konektag.points_lot_immutable();

CREATE FUNCTION konektag.points_no_monetary_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.financial_transaction_id AND currency='K') THEN
  RAISE EXCEPTION 'K_REGISTRY_MUST_NOT_BE_PROJECTED_AS_MONEY';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_no_monetary_projection BEFORE INSERT ON konektag.accounting_outbox FOR EACH ROW EXECUTE FUNCTION konektag.points_no_monetary_projection();
-- Monetary entries now preserve cents: the original BIGINT accumulators rounded
-- differences away and could incorrectly accept unbalanced monetary journals.
CREATE OR REPLACE FUNCTION konektag.check_balanced_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total_debit NUMERIC; total_credit NUMERIC; tx_id UUID;
BEGIN
 tx_id:=COALESCE(NEW.transaction_id,OLD.transaction_id);
 IF tx_id IS NULL THEN RETURN NEW; END IF;
 SELECT COALESCE(SUM(amount) FILTER(WHERE entry_side='debit'),0),
        COALESCE(SUM(amount) FILTER(WHERE entry_side='credit'),0)
 INTO total_debit,total_credit FROM konektag.ledger_entries WHERE transaction_id=tx_id;
 IF total_debit<>total_credit THEN RAISE EXCEPTION 'Unbalanced transaction %: debit % ≠ credit %',tx_id,total_debit,total_credit; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION konektag.points_transaction_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.currency IS DISTINCT FROM OLD.currency AND (NEW.currency='K' OR OLD.currency='K')
   AND EXISTS(SELECT 1 FROM konektag.ledger_entries WHERE transaction_id=OLD.id) THEN
   RAISE EXCEPTION 'POINTS_TRANSACTION_UNIT_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_transaction_unit_guard BEFORE UPDATE OF currency ON konektag.financial_transactions
 FOR EACH ROW EXECUTE FUNCTION konektag.points_transaction_unit_guard();
COMMIT;
