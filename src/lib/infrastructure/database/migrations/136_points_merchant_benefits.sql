BEGIN;

-- Approval is explicit and tied to the real merchant, never inferred from a rail.
CREATE TABLE konektag.merchant_points_benefit_eligibility (
  merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id),
  physical_merchant BOOLEAN NOT NULL CHECK(physical_merchant),
  approved BOOLEAN NOT NULL DEFAULT false,
  approval_reference TEXT NOT NULL CHECK(length(approval_reference)>0),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE TABLE konektag.points_accounting_roles (
  legal_entity_id UUID NOT NULL REFERENCES konektag.legal_entities(id),
  functional_role TEXT NOT NULL CHECK(functional_role='MERCHANT_BONUS_EXPENSE_GL'),
  account_code TEXT NOT NULL CHECK(length(account_code)>0 AND account_code NOT IN('1000','K_ISSUANCE','K_ALLOCATION_CLEARING')),
  approval_reference TEXT NOT NULL CHECK(length(approval_reference)>0),
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY(legal_entity_id,functional_role)
);
CREATE TABLE konektag.points_merchant_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  party_id UUID NOT NULL REFERENCES konektag.parties(id),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  legal_entity_id UUID NOT NULL REFERENCES konektag.legal_entities(id),
  k_transaction_id UUID NOT NULL UNIQUE REFERENCES konektag.financial_transactions(id),
  monetary_transaction_id UUID NOT NULL UNIQUE REFERENCES konektag.financial_transactions(id),
  reservation_id UUID NOT NULL UNIQUE REFERENCES konektag.api_payment_wallet_reservations(id),
  quantity BIGINT NOT NULL CHECK(quantity>0),
  currency VARCHAR(3) NOT NULL CHECK(currency='EUR'),
  merchant_value NUMERIC(24,8) NOT NULL CHECK(merchant_value>=0 AND merchant_value<=quantity),
  eligible BOOLEAN NOT NULL,
  eligibility_reference TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN('completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK(NOT eligible OR eligibility_reference IS NOT NULL)
);
CREATE TABLE konektag.fee_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumption_id UUID NOT NULL UNIQUE REFERENCES konektag.points_merchant_consumptions(id),
  party_id UUID NOT NULL REFERENCES konektag.parties(id),
  currency VARCHAR(3) NOT NULL,
  rate NUMERIC(12,8) NOT NULL CHECK(rate=0.0025),
  initial_amount NUMERIC(24,8) NOT NULL CHECK(initial_amount>0),
  remaining_amount NUMERIC(24,8) NOT NULL CHECK(remaining_amount>=0 AND remaining_amount<=initial_amount),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN('available','reserved','consumed','cancelled','recovery_required')),
  recovery_amount NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK(recovery_amount>=0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX fee_credit_available_owner ON konektag.fee_credits(party_id,currency,created_at,id) WHERE status='available';
CREATE TABLE konektag.fee_credit_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  party_id UUID NOT NULL REFERENCES konektag.parties(id),
  currency VARCHAR(3) NOT NULL,
  fees_due NUMERIC(24,8) NOT NULL CHECK(fees_due>=0),
  amount_applied NUMERIC(24,8) NOT NULL CHECK(amount_applied>=0 AND amount_applied<=fees_due),
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN('reserved','applied','released')),
  unfunded_amount NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK(unfunded_amount>=0),
  finalized_at TIMESTAMPTZ,
  settlement_decimals SMALLINT NOT NULL CHECK(settlement_decimals BETWEEN 0 AND 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE konektag.fee_credit_uses (
  application_id UUID NOT NULL REFERENCES konektag.fee_credit_applications(id),
  fee_credit_id UUID NOT NULL REFERENCES konektag.fee_credits(id),
  amount NUMERIC(24,8) NOT NULL CHECK(amount>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(application_id,fee_credit_id)
);
ALTER TABLE konektag.merchant_settlements ADD COLUMN points_bonus_amount NUMERIC(24,8) NOT NULL DEFAULT 0,
 ADD COLUMN points_bonus_review_required BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE konektag.merchant_points_bonuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumption_id UUID NOT NULL UNIQUE REFERENCES konektag.points_merchant_consumptions(id),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  legal_entity_id UUID NOT NULL REFERENCES konektag.legal_entities(id),
  currency VARCHAR(3) NOT NULL,
  rate NUMERIC(12,8) NOT NULL CHECK(rate=0.01),
  amount NUMERIC(24,8) NOT NULL CHECK(amount>0),
  expense_role TEXT NOT NULL CHECK(expense_role='MERCHANT_BONUS_EXPENSE_GL'),
  status TEXT NOT NULL DEFAULT 'earned' CHECK(status IN('earned','reversed')),
  projection_status TEXT NOT NULL DEFAULT 'pending_mapping' CHECK(projection_status IN('pending_mapping','pending','projected','error')),
  reversal_projection_status TEXT NOT NULL DEFAULT 'not_required' CHECK(reversal_projection_status IN('not_required','pending','projected','error')),
  projection_error TEXT,
  accounting_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
  reversal_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ
);
CREATE VIEW konektag.points_merchant_settlement_details AS
 SELECT c.id AS consumption_id,c.merchant_profile_id,c.currency,c.merchant_value,c.status AS consumption_status,
   COALESCE(s.commission_amount,0) AS commission_amount,COALESCE(s.tax_amount,0) AS tax_amount,
   CASE WHEN b.status='earned' THEN b.amount ELSE 0 END AS bonus_amount,
   CASE WHEN c.status='completed' THEN c.merchant_value+CASE WHEN b.status='earned' THEN b.amount ELSE 0 END ELSE 0 END AS gross_entitlement,
   CASE WHEN c.status='completed' THEN COALESCE(s.net_amount,0)+CASE WHEN b.status='earned' THEN b.amount ELSE 0 END ELSE 0 END AS net_due
 FROM konektag.points_merchant_consumptions c JOIN konektag.merchant_sales s ON s.transaction_id=c.monetary_transaction_id
 LEFT JOIN konektag.merchant_points_bonuses b ON b.consumption_id=c.id;

INSERT INTO konektag.financial_accounts(account_code,account_name,account_type,is_system,is_cash,description)
VALUES('MERCHANT_BONUS_EXPENSE_GL','Charge de bonification commerçant','expense',true,false,'Monetary only; company account resolved by approved functional role');

CREATE FUNCTION konektag.guard_points_benefit_identity()
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
    IF NEW.party_id<>c.party_id OR NEW.initial_amount<>c.merchant_value*0.0025 THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
  ELSE
    IF NEW.merchant_profile_id<>c.merchant_profile_id OR NEW.legal_entity_id<>c.legal_entity_id OR NEW.amount<>c.merchant_value*0.01 THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER fee_credit_source_guard BEFORE INSERT OR UPDATE ON konektag.fee_credits FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_benefit_identity();
CREATE TRIGGER merchant_bonus_source_guard BEFORE INSERT OR UPDATE ON konektag.merchant_points_bonuses FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_benefit_identity();

CREATE FUNCTION konektag.apply_fee_credit_to_fees(p_party UUID,p_operation TEXT,p_currency TEXT,p_fees NUMERIC,p_decimals INT,p_reserve BOOLEAN DEFAULT false)
RETURNS TABLE(application_id UUID,amount_applied TEXT,fees_remaining TEXT)
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a konektag.fee_credit_applications%ROWTYPE; r RECORD; v_total NUMERIC; v_left NUMERIC; v_use NUMERIC;
BEGIN
 IF p_fees<0 OR p_decimals<0 OR p_decimals>6 OR p_fees<>trunc(p_fees,p_decimals) OR length(p_operation)=0
 THEN RAISE EXCEPTION 'FEE_CREDIT_INVALID_FEE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||p_party::text,0));
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE operation_key=p_operation;
 IF FOUND THEN
  IF a.party_id<>p_party OR a.currency<>p_currency OR a.fees_due<>p_fees OR a.settlement_decimals<>p_decimals
  THEN RAISE EXCEPTION 'FEE_CREDIT_REPLAY_CONFLICT'; END IF;
  IF a.status='released' THEN RAISE EXCEPTION 'FEE_CREDIT_APPLICATION_RELEASED'; END IF;
  IF a.status='reserved' AND NOT p_reserve THEN PERFORM konektag.finish_fee_credit_application(p_operation,true); END IF;
  RETURN QUERY SELECT a.id,a.amount_applied::text,(a.fees_due-a.amount_applied)::text; RETURN;
 END IF;
 SELECT COALESCE(sum(f.remaining_amount),0) INTO v_total FROM konektag.fee_credits f
 JOIN konektag.points_merchant_consumptions c ON c.id=f.consumption_id
 WHERE f.party_id=p_party AND f.currency=p_currency AND f.status='available'
   AND c.operation_key<>p_operation AND c.created_at<transaction_timestamp();
 v_total:=least(p_fees,trunc(v_total,p_decimals)); v_left:=v_total;
 INSERT INTO konektag.fee_credit_applications(operation_key,party_id,currency,fees_due,amount_applied,settlement_decimals,status)
 VALUES(p_operation,p_party,p_currency,p_fees,v_total,p_decimals,CASE WHEN p_reserve THEN 'reserved' ELSE 'applied' END) RETURNING * INTO a;
 FOR r IN SELECT f.* FROM konektag.fee_credits f JOIN konektag.points_merchant_consumptions c ON c.id=f.consumption_id
  WHERE f.party_id=p_party AND f.currency=p_currency AND f.status='available' AND c.operation_key<>p_operation
    AND c.created_at<transaction_timestamp() ORDER BY f.created_at,f.id FOR UPDATE OF f
 LOOP
  EXIT WHEN v_left<=0;
  v_use:=least(v_left,r.remaining_amount);
  UPDATE konektag.fee_credits SET remaining_amount=remaining_amount-v_use,
    status=CASE WHEN remaining_amount=v_use THEN CASE WHEN p_reserve THEN 'reserved' ELSE 'consumed' END ELSE 'available' END,used_at=CASE WHEN p_reserve THEN used_at ELSE now() END WHERE id=r.id;
  INSERT INTO konektag.fee_credit_uses(application_id,fee_credit_id,amount) VALUES(a.id,r.id,v_use);
  v_left:=v_left-v_use;
 END LOOP;
 IF v_left<>0 THEN RAISE EXCEPTION 'FEE_CREDIT_ALLOCATION_MISMATCH'; END IF;
 RETURN QUERY SELECT a.id,a.amount_applied::text,(a.fees_due-a.amount_applied)::text;
END; $$;
REVOKE ALL ON FUNCTION konektag.apply_fee_credit_to_fees(UUID,TEXT,TEXT,NUMERIC,INT,BOOLEAN) FROM PUBLIC;

CREATE FUNCTION konektag.finish_fee_credit_application(p_operation TEXT,p_confirm BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a konektag.fee_credit_applications%ROWTYPE; u RECORD;
BEGIN
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE operation_key=p_operation;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||a.party_id::text,0));
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE id=a.id FOR UPDATE;
 IF a.status<>'reserved' THEN RETURN; END IF;
 FOR u IN SELECT f.*,x.amount AS used_amount FROM konektag.fee_credit_uses x
   JOIN konektag.fee_credits f ON f.id=x.fee_credit_id WHERE x.application_id=a.id FOR UPDATE OF f
 LOOP
  IF p_confirm THEN
   IF u.status IN('cancelled','recovery_required') THEN
    UPDATE konektag.fee_credit_applications SET unfunded_amount=unfunded_amount+u.used_amount WHERE id=a.id;
   ELSE
    UPDATE konektag.fee_credits SET used_at=now(),status=CASE WHEN remaining_amount=0 THEN 'consumed' ELSE 'available' END WHERE id=u.id;
   END IF;
  ELSIF u.status NOT IN('cancelled','recovery_required') THEN
   UPDATE konektag.fee_credits SET remaining_amount=remaining_amount+u.used_amount,status='available' WHERE id=u.id;
  END IF;
 END LOOP;
 UPDATE konektag.fee_credit_applications SET status=CASE WHEN p_confirm THEN 'applied' ELSE 'released' END,finalized_at=now() WHERE id=a.id;
END; $$;
REVOKE ALL ON FUNCTION konektag.finish_fee_credit_application(TEXT,BOOLEAN) FROM PUBLIC;

ALTER TABLE konektag.api_payment_orders ADD COLUMN fee_credit_applied_minor BIGINT NOT NULL DEFAULT 0 CHECK(fee_credit_applied_minor>=0);
ALTER TABLE konektag.api_payment_orders DROP CONSTRAINT points_quote_total;
ALTER TABLE konektag.api_payment_orders ADD CONSTRAINT points_quote_total CHECK(recharge_lot_id IS NULL OR total_payment_minor IS NULL
 OR (total_payment_minor=lot_value_minor+charged_psp_fee_minor+konektag_fee_minor+recharge_tax_minor-fee_credit_applied_minor
     AND fee_credit_applied_minor<=charged_psp_fee_minor+konektag_fee_minor));
CREATE FUNCTION konektag.release_recharge_fee_credit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.recharge_lot_id IS NOT NULL AND NEW.payment_status<>'confirmed' AND
  (NEW.payment_status='failed' OR (NEW.state IN('failed','expired') AND NEW.stripe_payment_intent_id IS NULL)) THEN
  PERFORM konektag.finish_fee_credit_application('recharge-fees:'||NEW.id::text,false);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER release_recharge_fee_credit AFTER UPDATE OF state,payment_status ON konektag.api_payment_orders
 FOR EACH ROW EXECUTE FUNCTION konektag.release_recharge_fee_credit();
REVOKE ALL ON FUNCTION konektag.release_recharge_fee_credit() FROM PUBLIC;

CREATE FUNCTION konektag.guard_points_consumption_identity()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-'status'-'cancelled_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'cancelled_at')
   OR OLD.status='cancelled' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_IMMUTABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER points_consumption_identity BEFORE UPDATE ON konektag.points_merchant_consumptions
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_consumption_identity();
CREATE FUNCTION konektag.check_points_consumption_completion()
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
CREATE CONSTRAINT TRIGGER points_consumption_completed AFTER INSERT OR UPDATE ON konektag.points_merchant_consumptions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_points_consumption_completion();
REVOKE ALL ON FUNCTION konektag.guard_points_consumption_identity(),konektag.check_points_consumption_completion() FROM PUBLIC;

CREATE FUNCTION konektag.guard_fee_application_history()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FEE_CREDIT_HISTORY_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='fee_credit_uses' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'FEE_CREDIT_HISTORY_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM konektag.fee_credit_applications a JOIN konektag.fee_credits f ON f.id=NEW.fee_credit_id
    JOIN konektag.points_merchant_consumptions c ON c.id=f.consumption_id
    WHERE a.id=NEW.application_id AND a.party_id=f.party_id AND a.currency=f.currency
      AND a.status IN('reserved','applied') AND c.operation_key<>a.operation_key AND c.created_at<a.created_at)
   THEN RAISE EXCEPTION 'FEE_CREDIT_USE_NOT_AUTHORIZED'; END IF;
 ELSE
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'status'-'unfunded_amount'-'finalized_at') IS DISTINCT FROM
       (to_jsonb(OLD)-'status'-'unfunded_amount'-'finalized_at') OR OLD.status<>'reserved' AND NEW IS DISTINCT FROM OLD)
   THEN RAISE EXCEPTION 'FEE_CREDIT_APPLICATION_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER fee_use_history BEFORE INSERT OR UPDATE OR DELETE ON konektag.fee_credit_uses FOR EACH ROW EXECUTE FUNCTION konektag.guard_fee_application_history();
CREATE TRIGGER fee_application_history BEFORE UPDATE OR DELETE ON konektag.fee_credit_applications FOR EACH ROW EXECUTE FUNCTION konektag.guard_fee_application_history();
CREATE FUNCTION konektag.check_fee_credit_conservation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE f konektag.fee_credits%ROWTYPE; v_used NUMERIC;
BEGIN
 SELECT * INTO f FROM konektag.fee_credits WHERE id=NEW.id;
 IF f.status IN('available','reserved','consumed') THEN
  SELECT COALESCE(sum(u.amount),0) INTO v_used FROM konektag.fee_credit_uses u
   JOIN konektag.fee_credit_applications a ON a.id=u.application_id
   WHERE u.fee_credit_id=f.id AND a.status IN('reserved','applied');
  IF f.remaining_amount<>f.initial_amount-v_used THEN RAISE EXCEPTION 'FEE_CREDIT_CONSERVATION_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER fee_credit_conservation AFTER INSERT OR UPDATE ON konektag.fee_credits
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_fee_credit_conservation();
ALTER TABLE konektag.fee_credits ADD CONSTRAINT fee_credit_terminal_balance CHECK(status='available' OR remaining_amount=0);
ALTER TABLE konektag.fee_credit_applications ADD CONSTRAINT fee_credit_unfunded_bound CHECK(unfunded_amount<=amount_applied);
REVOKE ALL ON FUNCTION konektag.guard_fee_application_history(),konektag.check_fee_credit_conservation() FROM PUBLIC;

REVOKE ALL ON FUNCTION konektag.guard_points_benefit_identity() FROM PUBLIC;
COMMIT;
