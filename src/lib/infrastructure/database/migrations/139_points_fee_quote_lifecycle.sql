BEGIN;
ALTER TABLE konektag.fee_credit_applications DROP CONSTRAINT fee_credit_applications_status_check;
ALTER TABLE konektag.fee_credit_applications ADD CONSTRAINT fee_credit_applications_status_check CHECK(status IN('reserved','applied','released','expired'));
ALTER TABLE konektag.fee_credit_applications ADD COLUMN expires_at TIMESTAMPTZ,
 ADD COLUMN transition_reason TEXT,
 ADD COLUMN lifecycle TEXT GENERATED ALWAYS AS (CASE status WHEN 'reserved' THEN 'active' WHEN 'applied' THEN 'consumed' ELSE status END) STORED;
CREATE INDEX fee_quotes_due ON konektag.fee_credit_applications(expires_at,party_id) WHERE status='reserved';
CREATE TABLE konektag.fee_credit_reservation_transitions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),application_id UUID NOT NULL REFERENCES konektag.fee_credit_applications(id),
 from_state TEXT,to_state TEXT NOT NULL CHECK(to_state IN('active','consumed','released','expired')),
 reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE konektag.fee_credit_payment_adjustments (
 application_id UUID PRIMARY KEY REFERENCES konektag.fee_credit_applications(id),
 order_id UUID NOT NULL UNIQUE REFERENCES konektag.api_payment_orders(id),
 amount NUMERIC(24,8) NOT NULL CHECK(amount>=0),currency TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'recovery_pending' CHECK(status IN('recovery_pending','resolved')),
 reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION konektag.prepare_fee_quote_expiry()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='reserved' THEN
  NEW.expires_at:=NULLIF(current_setting('konektag.fee_quote_expires_at',true),'')::timestamptz;
  IF NEW.expires_at IS NULL OR NEW.expires_at<=statement_timestamp() THEN RAISE EXCEPTION 'FEE_QUOTE_VALIDITY_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER fee_quote_expiry BEFORE INSERT ON konektag.fee_credit_applications FOR EACH ROW EXECUTE FUNCTION konektag.prepare_fee_quote_expiry();
CREATE OR REPLACE FUNCTION konektag.guard_fee_application_history()
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
  IF ROW(NEW.id,NEW.operation_key,NEW.party_id,NEW.currency,NEW.fees_due,NEW.amount_applied,NEW.settlement_decimals,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.operation_key,OLD.party_id,OLD.currency,OLD.fees_due,OLD.amount_applied,OLD.settlement_decimals,OLD.created_at)
   OR OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
   OR OLD.status<>'reserved' AND ROW(NEW.status,NEW.unfunded_amount,NEW.finalized_at,NEW.transition_reason)
    IS DISTINCT FROM ROW(OLD.status,OLD.unfunded_amount,OLD.finalized_at,OLD.transition_reason)
   THEN RAISE EXCEPTION 'FEE_CREDIT_APPLICATION_IMMUTABLE'; END IF;
  IF OLD.status='reserved' AND NEW.status='applied' AND OLD.expires_at<=statement_timestamp()
   THEN RAISE EXCEPTION 'FEE_QUOTE_EXPIRED'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION konektag.trace_fee_quote_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.status<>OLD.status THEN
  INSERT INTO konektag.fee_credit_reservation_transitions(application_id,from_state,to_state,reason)
  VALUES(NEW.id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.lifecycle END,NEW.lifecycle,COALESCE(NEW.transition_reason,'quote_created'));
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER fee_quote_transition AFTER INSERT OR UPDATE OF status ON konektag.fee_credit_applications FOR EACH ROW EXECUTE FUNCTION konektag.trace_fee_quote_transition();
CREATE OR REPLACE FUNCTION konektag.finish_fee_credit_application(p_operation TEXT,p_confirm BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a konektag.fee_credit_applications%ROWTYPE; u RECORD;
BEGIN
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE operation_key=p_operation;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||a.party_id::text,0));
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE id=a.id FOR UPDATE;
 IF a.status='applied' THEN RETURN; END IF;
 IF a.status IN('released','expired') THEN
  IF p_confirm THEN RAISE EXCEPTION 'FEE_QUOTE_NOT_ACTIVE'; END IF; RETURN;
 END IF;
 IF p_confirm AND a.expires_at IS NULL THEN RAISE EXCEPTION 'FEE_QUOTE_VALIDITY_REQUIRED'; END IF;
 IF p_confirm AND a.expires_at<=statement_timestamp() THEN RAISE EXCEPTION 'FEE_QUOTE_EXPIRED'; END IF;
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
 UPDATE konektag.fee_credit_applications SET status=CASE WHEN p_confirm THEN 'applied' WHEN expires_at<=statement_timestamp() THEN 'expired' ELSE 'released' END,
 transition_reason=CASE WHEN p_confirm THEN 'operation_confirmed' WHEN expires_at<=statement_timestamp() THEN 'quote_expired' ELSE 'operation_cancelled' END,
 finalized_at=now() WHERE id=a.id;
END; $$;
CREATE FUNCTION konektag.reserve_fee_credit_quote(p_party UUID,p_operation TEXT,p_currency TEXT,p_fees NUMERIC,p_decimals INT,p_expires TIMESTAMPTZ)
RETURNS TABLE(application_id UUID,amount_applied TEXT,fees_remaining TEXT) LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a konektag.fee_credit_applications%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||p_party::text,0));
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE operation_key=p_operation;
 IF FOUND AND (a.status IN('released','expired') OR a.status='reserved' AND a.expires_at<=statement_timestamp())
 THEN RAISE EXCEPTION 'FEE_QUOTE_NOT_ACTIVE'; END IF;
 PERFORM set_config('konektag.fee_quote_expires_at',p_expires::text,true);
 RETURN QUERY SELECT * FROM konektag.apply_fee_credit_to_fees(p_party,p_operation,p_currency,p_fees,p_decimals,true);
END; $$;
CREATE FUNCTION konektag.expire_fee_credit_quotes()
RETURNS INT LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a RECORD; n INT:=0;
BEGIN
 FOR a IN SELECT id,party_id,operation_key FROM konektag.fee_credit_applications
 WHERE status='reserved' AND expires_at<=statement_timestamp() ORDER BY party_id,id LIMIT 100
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||a.party_id::text,0));
  IF EXISTS(SELECT 1 FROM konektag.fee_credit_applications WHERE id=a.id AND status='reserved') THEN
   PERFORM konektag.finish_fee_credit_application(a.operation_key,false); n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END; $$;
-- Verified late payment must still acquire its K lot. It cannot consume a released
-- discount: record the unfunded monetary discount once for explicit reconciliation.
CREATE FUNCTION konektag.settle_recharge_fee_credit(p_order UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a konektag.fee_credit_applications%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM konektag.points_payment_confirmations WHERE order_id=p_order)
 THEN RAISE EXCEPTION 'VERIFIED_PSP_CONFIRMATION_REQUIRED'; END IF;
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE operation_key='recharge-fees:'||p_order::text;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||a.party_id::text,0));
 SELECT * INTO a FROM konektag.fee_credit_applications WHERE id=a.id FOR UPDATE;
 IF a.status='reserved' AND a.expires_at<=statement_timestamp() THEN
  PERFORM konektag.finish_fee_credit_application(a.operation_key,false);
  SELECT * INTO a FROM konektag.fee_credit_applications WHERE id=a.id;
 END IF;
 IF a.status IN('released','expired') THEN
  INSERT INTO konektag.fee_credit_payment_adjustments(application_id,order_id,amount,currency,reason)
  VALUES(a.id,p_order,a.amount_applied,a.currency,'verified_payment_after_discount_release') ON CONFLICT(application_id) DO NOTHING;
 ELSE PERFORM konektag.finish_fee_credit_application(a.operation_key,true); END IF;
END; $$;
CREATE OR REPLACE FUNCTION konektag.release_recharge_fee_credit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.recharge_lot_id IS NOT NULL AND NEW.payment_status<>'confirmed' AND
 (NEW.payment_status='failed' OR NEW.state IN('failed','expired','cancelled')) THEN
  PERFORM konektag.finish_fee_credit_application('recharge-fees:'||NEW.id::text,false);
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION konektag.prepare_fee_quote_expiry(),konektag.trace_fee_quote_transition(),
 konektag.reserve_fee_credit_quote(UUID,TEXT,TEXT,NUMERIC,INT,TIMESTAMPTZ),konektag.expire_fee_credit_quotes(),konektag.settle_recharge_fee_credit(UUID) FROM PUBLIC;
CREATE OR REPLACE FUNCTION konektag.apply_fee_credit_to_fees(p_party UUID,p_operation TEXT,p_currency TEXT,p_fees NUMERIC,p_decimals INT,p_reserve BOOLEAN DEFAULT false)
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
  IF a.status IN('released','expired') THEN RAISE EXCEPTION 'FEE_CREDIT_APPLICATION_RELEASED'; END IF;
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
CREATE FUNCTION konektag.guard_confirmed_recharge_state()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.recharge_lot_id IS NOT NULL AND NEW.payment_status='confirmed' AND NEW.state IN('failed','expired','cancelled')
 THEN RAISE EXCEPTION 'POINTS_CONFIRMED_PAYMENT_NOT_CANCELLABLE'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER confirmed_recharge_state BEFORE UPDATE OF state,payment_status ON konektag.api_payment_orders
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_confirmed_recharge_state();
REVOKE ALL ON FUNCTION konektag.guard_confirmed_recharge_state() FROM PUBLIC;
-- Old active quotes have no stored deadline. Initialize only that new metadata
-- from the same runtime policy; never rewrite their amounts or creation dates.
CREATE FUNCTION konektag.initialize_fee_quote_validity(p_minutes INT)
RETURNS INT LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a RECORD; n INT:=0; changed INT;
BEGIN
 IF p_minutes IS NULL OR p_minutes<5 OR p_minutes>10080 THEN RAISE EXCEPTION 'FEE_QUOTE_POLICY_INVALID'; END IF;
 FOR a IN SELECT id,party_id FROM konektag.fee_credit_applications WHERE status='reserved' AND expires_at IS NULL ORDER BY party_id,id LIMIT 100
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||a.party_id::text,0));
  UPDATE konektag.fee_credit_applications SET expires_at=created_at+make_interval(mins=>p_minutes)
   WHERE id=a.id AND expires_at IS NULL AND status='reserved';
  GET DIAGNOSTICS changed=ROW_COUNT; n:=n+changed;
 END LOOP;
 RETURN n;
END; $$;
REVOKE ALL ON FUNCTION konektag.initialize_fee_quote_validity(INT) FROM PUBLIC;
COMMIT;
