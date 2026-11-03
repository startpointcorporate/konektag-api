-- Only Link Pay adopts this Points K identity. Historical financial parents remain intact.
BEGIN;
CREATE TABLE konektag.k_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_key text NOT NULL UNIQUE CHECK(length(trim(operation_key))>0),
 operation_type text NOT NULL CHECK(operation_type IN ('merchant_consumption','refund')),
 party_id uuid NOT NULL REFERENCES konektag.parties(id),
 quantity bigint NOT NULL CHECK(quantity>0),
 reservation_id uuid UNIQUE REFERENCES konektag.api_payment_wallet_reservations(id),
 source_operation_id uuid REFERENCES konektag.k_operations(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK((status='completed')=(completed_at IS NOT NULL)),
 CHECK((operation_type='merchant_consumption' AND reservation_id IS NOT NULL AND source_operation_id IS NULL)
    OR (operation_type='refund' AND reservation_id IS NULL AND source_operation_id IS NOT NULL))
);
COMMENT ON TABLE konektag.k_operations IS 'Points K only; not financial transactions or a general ledger.';
ALTER TABLE konektag.ledger_entries ADD COLUMN k_operation_id uuid REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT k_ledger_parent CHECK(k_operation_id IS NULL OR
   (transaction_id IS NULL AND currency='K' AND legal_entity_id IS NULL AND corridor_id IS NULL
    AND regulatory_profile_id IS NULL AND account_code IN ('1000','K_ISSUANCE')));
CREATE INDEX ledger_k_operation ON konektag.ledger_entries(k_operation_id) WHERE k_operation_id IS NOT NULL;
ALTER TABLE konektag.api_payment_wallet_reservations
 ADD COLUMN k_operation_id uuid UNIQUE REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT reservation_k_parent CHECK(k_operation_id IS NULL OR
   (consumption_transaction_id IS NULL AND currency='K' AND lifecycle='captured' AND operation_key IS NOT NULL));
ALTER TABLE konektag.points_merchant_consumptions
 ALTER COLUMN k_transaction_id DROP NOT NULL, ALTER COLUMN monetary_transaction_id DROP NOT NULL,
 ADD COLUMN k_operation_id uuid UNIQUE REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT consumption_parent CHECK(
  (k_operation_id IS NULL AND k_transaction_id IS NOT NULL AND monetary_transaction_id IS NOT NULL) OR
  (k_operation_id IS NOT NULL AND k_transaction_id IS NULL AND monetary_transaction_id IS NULL
   AND legal_entity_id IS NULL AND payment_rail='payment_link' AND value_basis_version=2));
ALTER TABLE konektag.merchant_sales ADD COLUMN k_operation_id uuid UNIQUE REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT sale_k_parent CHECK(k_operation_id IS NULL OR (transaction_id IS NULL AND legal_entity_id IS NULL));
ALTER TABLE konektag.checkout_intents ADD COLUMN k_operation_id uuid UNIQUE REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT link_k_parent CHECK(k_operation_id IS NULL OR
   (source_type='payment_link' AND status='CONSUMED' AND financial_transaction_id IS NULL));
ALTER TABLE konektag.points_merchant_refunds ALTER COLUMN k_transaction_id DROP NOT NULL,
 ADD COLUMN k_operation_id uuid UNIQUE REFERENCES konektag.k_operations(id),
 ADD CONSTRAINT refund_k_parent CHECK((k_operation_id IS NULL)<>(k_transaction_id IS NULL));

CREATE FUNCTION konektag.guard_k_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE valid boolean; b record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'K_OPERATION_IMMUTABLE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||NEW.party_id::text,0));
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN RAISE EXCEPTION 'K_OPERATION_MUST_START_PENDING'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='completed' OR (to_jsonb(NEW)-'status'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'completed_at')
 THEN RAISE EXCEPTION 'K_OPERATION_IMMUTABLE'; END IF;
 IF NEW.status='completed' THEN
  SELECT count(*)=2 AND count(*) FILTER(WHERE account_code='1000')=1
   AND bool_and(e.amount=NEW.quantity AND e.currency='K' AND e.gl_scope='GLOBAL_USER_GL'
    AND ((e.account_code='1000' AND e.party_id=NEW.party_id AND e.entry_side=CASE WHEN NEW.operation_type='refund' THEN 'credit' ELSE 'debit' END)
     OR(e.account_code='K_ISSUANCE' AND e.party_id IS NULL AND e.entry_side=CASE WHEN NEW.operation_type='refund' THEN 'debit' ELSE 'credit' END)))
   INTO valid FROM konektag.ledger_entries e WHERE e.k_operation_id=NEW.id;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'K_OPERATION_LEDGER_PROOF_REQUIRED'; END IF;
  IF NEW.operation_type='merchant_consumption' THEN
   IF NOT EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations r WHERE r.id=NEW.reservation_id
     AND r.payer_party_id=NEW.party_id AND r.amount=NEW.quantity AND r.currency='K'
     AND r.lifecycle='active' AND r.expires_at>statement_timestamp()) THEN RAISE EXCEPTION 'POINTS_RESERVATION_NOT_ACTIVE'; END IF;
   SELECT * INTO b FROM konektag.points_balance(NEW.party_id);
   IF b.balance<NEW.quantity OR b.available<0 THEN RAISE EXCEPTION 'POINTS_INSUFFICIENT'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM konektag.k_operations s WHERE s.id=NEW.source_operation_id
    AND s.operation_type='merchant_consumption' AND s.status='completed' AND s.party_id=NEW.party_id)
  THEN RAISE EXCEPTION 'K_REFUND_SOURCE_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER k_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON konektag.k_operations
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_k_operation();

CREATE FUNCTION konektag.project_k_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status='pending' THEN
  INSERT INTO konektag.k_wallet_entries(party_id,operation_id,operation_type,direction,quantity_k,source_type,source_id,created_at)
   SELECT e.party_id,NEW.id,CASE WHEN NEW.operation_type='refund' THEN 'refund' ELSE 'payment' END,
    e.entry_side,e.amount::bigint,'k_operation_ledger',e.id::text,e.created_at
   FROM konektag.ledger_entries e WHERE e.k_operation_id=NEW.id AND e.account_code='1000';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER k_operation_wallet AFTER UPDATE ON konektag.k_operations
 FOR EACH ROW EXECUTE FUNCTION konektag.project_k_operation();

CREATE FUNCTION konektag.check_k_operation_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE k konektag.k_operations%ROWTYPE;
BEGIN
 SELECT * INTO k FROM konektag.k_operations WHERE id=NEW.id;
 IF k.status<>'completed' THEN RAISE EXCEPTION 'K_OPERATION_INCOMPLETE'; END IF;
 IF k.operation_type='merchant_consumption' THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations r WHERE r.id=k.reservation_id
    AND r.k_operation_id=k.id AND r.lifecycle='captured') THEN RAISE EXCEPTION 'K_CAPTURE_REQUIRED'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM konektag.points_merchant_refunds r JOIN konektag.points_merchant_consumptions c ON c.id=r.consumption_id
   WHERE r.k_operation_id=k.id AND r.quantity=k.quantity AND c.k_operation_id=k.source_operation_id)
  THEN RAISE EXCEPTION 'K_REFUND_PROOF_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER k_operation_completed AFTER INSERT OR UPDATE ON konektag.k_operations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_k_operation_completion();

CREATE OR REPLACE FUNCTION konektag.points_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.k_operation_id IS NOT NULL THEN
  PERFORM 1 FROM konektag.k_operations WHERE id=NEW.k_operation_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FINAL_K_OPERATION_IMMUTABLE'; END IF;
  IF NEW.currency IS DISTINCT FROM 'K' OR NEW.amount IS NULL OR NEW.amount<=0 OR NEW.amount<>trunc(NEW.amount)
    OR NEW.entry_side NOT IN ('debit','credit') OR NEW.entry_type IS DISTINCT FROM NEW.entry_side
    OR NEW.account_code NOT IN ('1000','K_ISSUANCE')
    OR (NEW.account_code='1000' AND NEW.party_id IS NULL) OR (NEW.account_code='K_ISSUANCE' AND NEW.party_id IS NOT NULL)
  THEN RAISE EXCEPTION 'K_OPERATION_ENTRY_INVALID'; END IF;
  NEW.gl_scope:='GLOBAL_USER_GL'; NEW.legacy_classification:=NULL;
  RETURN NEW;
 END IF;
 IF NEW.currency = 'K' OR NEW.account_code IN ('K_ISSUANCE','K_ALLOCATION_CLEARING') THEN
   IF NEW.currency <> 'K' OR NEW.amount <> trunc(NEW.amount) OR NEW.amount <= 0 THEN
     RAISE EXCEPTION 'POINTS_ACCOUNT_REQUIRES_K_INTEGER';
   END IF;
   IF NEW.account_code = '1000' AND NEW.party_id IS NULL THEN RAISE EXCEPTION 'POINTS_OWNER_REQUIRED'; END IF;
   IF NEW.account_code <> '1000' AND NEW.party_id IS NOT NULL THEN RAISE EXCEPTION 'SYSTEM_POINTS_ACCOUNT_HAS_NO_USER'; END IF;
   IF NEW.transaction_id IS NULL THEN RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND currency='K') THEN RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRES_K'; END IF;
   IF EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND status IN ('completed','reversed')) THEN RAISE EXCEPTION 'FINAL_POINTS_TRANSACTION_IMMUTABLE'; END IF;
   NEW.gl_scope := 'GLOBAL_USER_GL'; NEW.legacy_classification := NULL;
 ELSIF NEW.currency IS NOT NULL AND NEW.account_code = '1000' THEN
   IF NEW.party_id IS NULL THEN RAISE EXCEPTION 'WALLET_OWNER_REQUIRED'; END IF;
   IF NEW.transaction_id IS NULL THEN RAISE EXCEPTION 'WALLET_TRANSACTION_REQUIRED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM konektag.financial_transactions t WHERE t.id=NEW.transaction_id
   AND (t.currency='K' OR NEW.currency='K') AND t.currency<>NEW.currency) THEN
   RAISE EXCEPTION 'POINTS_TRANSACTION_UNIT_MISMATCH';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION konektag.derive_v3_gl_scope() RETURNS trigger AS $$
DECLARE entity_code text;
BEGIN
 IF NEW.k_operation_id IS NOT NULL THEN NEW.gl_scope:='GLOBAL_USER_GL'; NEW.legacy_classification:=NULL; RETURN NEW; END IF;
 IF NEW.account_code ~ '^[467]' THEN
   IF NEW.legal_entity_id IS NULL THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_REQUIRED'; END IF;
   IF NOT EXISTS (SELECT 1 FROM konektag.legal_entities WHERE id=NEW.legal_entity_id AND status='APPROVED' AND deleted_at IS NULL)
   THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_NOT_APPROVED'; END IF;
 END IF;
 IF NEW.transaction_id IS NULL OR NEW.operation_id IS NULL THEN
   NEW.legacy_classification:=COALESCE(NEW.legacy_classification,'REQUIRES_RECONCILIATION'); RETURN NEW;
 END IF;
 IF NEW.currency IS NULL OR NEW.amount IS NULL OR NEW.amount<=0 OR NEW.entry_side IS NULL OR NEW.account_code IS NULL
 THEN RAISE EXCEPTION 'V3 ledger entry requires currency, positive amount, side, account and operation identity'; END IF;
 IF NEW.account_code IN ('1000','K_ISSUANCE','2000','8000') THEN
   NEW.gl_scope:='GLOBAL_USER_GL'; NEW.legacy_classification:=NULL; RETURN NEW;
 END IF;
 IF NEW.account_code ~ '^[467]' AND NEW.account_code NOT IN ('2000','8000') AND NEW.legal_entity_id IS NULL
 THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_REQUIRED'; END IF;
 IF NEW.legal_entity_id IS NULL THEN
   NEW.gl_scope:=NULL; NEW.legacy_classification:='PRINCIPAL_NO_ENTITY'; RETURN NEW;
 END IF;
 SELECT code INTO entity_code FROM konektag.legal_entities
  WHERE id=NEW.legal_entity_id AND deleted_at IS NULL AND status='APPROVED';
 IF entity_code IS NULL OR entity_code NOT IN ('KTG-FR','KTG-CG') THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_NOT_APPROVED'; END IF;
 NEW.gl_scope:=CASE WHEN entity_code='KTG-FR' THEN 'KONEKTAG_FRANCE_GL' ELSE 'KONEKTAG_CONGO_GL' END;
 NEW.legacy_classification:=NULL; RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION konektag.guard_points_reservation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_available NUMERIC; v_valid BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.currency = 'K' THEN
    IF ROW(NEW.payer_party_id, NEW.amount, NEW.currency, NEW.operation_key,
           NEW.payment_order_id, NEW.authorization_id, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.payer_party_id, OLD.amount, OLD.currency, OLD.operation_key,
           OLD.payment_order_id, OLD.authorization_id, OLD.expires_at) THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_IMMUTABLE';
    END IF;
    IF OLD.lifecycle <> 'active' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_TERMINAL';
    END IF;
  END IF;
  IF NEW.currency <> 'K' THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('points-wallet:' || NEW.payer_party_id::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'active' OR NEW.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'POINTS_RESERVATION_NOT_ACTIVE';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM konektag.parties WHERE id = NEW.payer_party_id AND is_active) THEN
      RAISE EXCEPTION 'POINTS_OWNER_UNAVAILABLE';
    END IF;
    SELECT b.available INTO v_available FROM konektag.points_balance(NEW.payer_party_id) b;
    IF NEW.amount > v_available THEN RAISE EXCEPTION 'POINTS_INSUFFICIENT'; END IF;
  ELSIF NEW.lifecycle = 'captured' AND OLD.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'POINTS_RESERVATION_EXPIRED';
  END IF;
  IF NEW.k_operation_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM konektag.k_operations k WHERE k.id=NEW.k_operation_id AND k.reservation_id=NEW.id
      AND k.operation_type='merchant_consumption' AND k.status='completed' AND k.party_id=NEW.payer_party_id AND k.quantity=NEW.amount)
    THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.operation_key IS NOT NULL AND NEW.lifecycle = 'captured' THEN
    SELECT count(*) = 2 AND bool_and(e.currency = 'K' AND e.amount = NEW.amount
      AND e.gl_scope = 'GLOBAL_USER_GL' AND
      ((e.account_code = '1000' AND e.entry_side = 'debit' AND e.party_id = NEW.payer_party_id)
       OR (e.account_code = 'K_ISSUANCE' AND e.entry_side = 'credit' AND e.party_id IS NULL)))
      INTO v_valid
    FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id = e.transaction_id
    WHERE t.id = NEW.consumption_transaction_id AND t.currency = 'K'
      AND t.transaction_type = 'consumption' AND t.status = 'completed';
    IF v_valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION konektag.check_points_consumption_completion()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE; v_good BOOLEAN; v_base NUMERIC;
BEGIN
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=NEW.id;
 IF c.k_operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.k_operations k JOIN konektag.api_payment_wallet_reservations r ON r.k_operation_id=k.id
   WHERE k.id=c.k_operation_id AND k.operation_type='merchant_consumption' AND k.status='completed'
     AND k.party_id=c.party_id AND k.quantity=c.quantity AND k.reservation_id=c.reservation_id
     AND r.id=c.reservation_id AND r.lifecycle='captured' AND r.payer_party_id=c.party_id AND r.amount=c.quantity)
  THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
 ELSE
 SELECT count(*)=2 AND bool_and(e.currency='K' AND e.gl_scope='GLOBAL_USER_GL' AND e.amount=c.quantity
   AND ((e.account_code='1000' AND e.entry_side='debit' AND e.party_id=c.party_id)
     OR(e.account_code='K_ISSUANCE' AND e.entry_side='credit' AND e.party_id IS NULL))) INTO v_good
 FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id=e.transaction_id
 WHERE t.id=c.k_transaction_id AND t.status='completed' AND t.currency='K';
 IF v_good IS DISTINCT FROM TRUE OR NOT EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations r
   WHERE r.id=c.reservation_id AND r.payer_party_id=c.party_id AND r.amount=c.quantity AND r.currency='K'
     AND r.lifecycle='captured' AND r.consumption_transaction_id=c.k_transaction_id)
 THEN RAISE EXCEPTION 'POINTS_CONSUMPTION_PROOF_REQUIRED'; END IF;
 END IF;
 IF c.value_basis_version=2 THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.merchant_sales s WHERE ((c.k_operation_id IS NULL AND s.transaction_id=c.monetary_transaction_id) OR (c.k_operation_id IS NOT NULL AND s.k_operation_id=c.k_operation_id))
    AND s.merchant_profile_id=c.merchant_profile_id
    AND s.currency=c.transaction_currency AND s.gross_amount=c.transaction_amount_minor)
  THEN RAISE EXCEPTION 'POINTS_TRANSACTION_MISMATCH'; END IF;
  IF c.cashback_amount IS NOT NULL THEN
   IF NOT c.eligible OR (SELECT count(*) FROM konektag.fee_credits WHERE consumption_id=c.id)<>1
   THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
  ELSIF EXISTS(SELECT 1 FROM konektag.fee_credits WHERE consumption_id=c.id)
  THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  -- No merchant bonus or accounting outbox is a payment completion proof.
  -- Compensation may consume these commercial facts later, independently.
  RETURN NULL;
 END IF;
 SELECT least(c.quantity,COALESCE(o.subtotal_amount,s.gross_amount)) INTO v_base
 FROM konektag.merchant_sales s JOIN konektag.api_payment_wallet_reservations r ON r.id=c.reservation_id
 LEFT JOIN konektag.api_payment_orders o ON o.id=r.payment_order_id
 WHERE s.transaction_id=c.monetary_transaction_id AND s.merchant_profile_id=c.merchant_profile_id
   AND s.currency=c.currency;
 IF v_base IS NULL OR v_base<>c.merchant_value THEN RAISE EXCEPTION 'POINTS_MERCHANT_VALUE_MISMATCH'; END IF;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION konektag.refund_link_k_points(p_source UUID,p_key TEXT,p_actor UUID,p_quantity BIGINT,p_reason TEXT)
RETURNS konektag.points_merchant_refunds LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE; r konektag.points_merchant_refunds%ROWTYPE;
 f konektag.fee_credits%ROWTYPE; a RECORD;
 previous_q BIGINT; q BIGINT; base NUMERIC; bonus NUMERIC; fee NUMERIC; recovery NUMERIC:=0;
 rid UUID:=gen_random_uuid(); tid UUID:=gen_random_uuid();
BEGIN
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=p_source;
 IF NOT FOUND OR c.k_operation_id IS NULL OR c.payment_rail<>'payment_link' THEN RAISE EXCEPTION 'POINTS_REFUND_SOURCE_NOT_FOUND'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||c.party_id::text,0));
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=p_source FOR UPDATE;
 PERFORM id FROM konektag.merchant_sales WHERE k_operation_id=c.k_operation_id FOR UPDATE;
 SELECT * INTO r FROM konektag.points_merchant_refunds WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF r.consumption_id<>p_source OR r.actor_user_id<>p_actor OR r.requested_quantity IS DISTINCT FROM p_quantity OR r.reason<>p_reason
   THEN RAISE EXCEPTION 'POINTS_REFUND_REPLAY_CONFLICT'; END IF;
  RETURN r;
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO previous_q FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 q:=COALESCE(p_quantity,c.quantity-previous_q);
 IF q<=0 OR previous_q+q>c.quantity THEN RAISE EXCEPTION 'POINTS_REFUND_EXCEEDS_REMAINING'; END IF;
 IF c.value_basis_version=2 THEN
  SELECT round(c.k_value_amount*(previous_q+q)/c.quantity,8)-COALESCE(sum(merchant_value),0),
   round(COALESCE((SELECT amount FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id),0)*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0),
   CASE WHEN c.cashback_amount IS NOT NULL
     THEN round(c.cashback_amount*(previous_q+q)/c.quantity,8)-COALESCE(sum(fee_credit_reversal),0) ELSE 0 END
  INTO base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 ELSE
  SELECT round(c.merchant_value*(previous_q+q)/c.quantity,8)-COALESCE(sum(merchant_value),0),
   CASE WHEN c.eligible THEN round(c.merchant_value*0.01*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0) ELSE 0 END,
   CASE WHEN c.eligible THEN round(c.merchant_value*0.0025*(previous_q+q)/c.quantity,8)-COALESCE(sum(fee_credit_reversal),0) ELSE 0 END
  INTO base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 END IF;
 SELECT * INTO f FROM konektag.fee_credits WHERE consumption_id=p_source FOR UPDATE;
 IF FOUND THEN
  FOR a IN SELECT x.operation_key FROM konektag.fee_credit_applications x JOIN konektag.fee_credit_uses u ON u.application_id=x.id
   WHERE u.fee_credit_id=f.id AND x.status='reserved' ORDER BY x.id
  LOOP PERFORM konektag.finish_fee_credit_application(a.operation_key,false); END LOOP;
  SELECT * INTO f FROM konektag.fee_credits WHERE id=f.id FOR UPDATE;
  recovery:=greatest(0,fee-f.remaining_amount);
  UPDATE konektag.fee_credits SET remaining_amount=greatest(0,remaining_amount-fee),reversed_amount=reversed_amount+fee,
   recovery_amount=recovery_amount+recovery,
   status=CASE WHEN remaining_amount>fee THEN 'available' WHEN recovery_amount+recovery>0 THEN 'recovery_required' ELSE 'cancelled' END,
   cancelled_at=CASE WHEN remaining_amount<=fee THEN now() ELSE cancelled_at END WHERE id=f.id;
 END IF;
 INSERT INTO konektag.k_operations(id,operation_key,operation_type,party_id,quantity,source_operation_id)
 VALUES(tid,'points-refund:'||p_key,'refund',c.party_id,q,c.k_operation_id);
 INSERT INTO konektag.points_merchant_refunds(id,consumption_id,idempotency_key,actor_user_id,reason,requested_quantity,
  quantity,merchant_value,bonus_reversal,fee_credit_reversal,fee_credit_recovery_pending,k_operation_id)
 VALUES(rid,p_source,p_key,p_actor,p_reason,p_quantity,q,base,bonus,fee,recovery,tid) RETURNING * INTO r;
 INSERT INTO konektag.ledger_entries(k_operation_id,account_code,entry_type,entry_side,party_id,amount,currency,document_type,document_ref,value_date)
 VALUES(tid,'K_ISSUANCE','debit','debit',NULL,q,'K','refund',rid::text,CURRENT_DATE),
 (tid,'1000','credit','credit',c.party_id,q,'K','refund',rid::text,CURRENT_DATE);
 UPDATE konektag.k_operations SET status='completed',completed_at=now() WHERE id=tid;
 -- Only a pre-existing bonus has an accounting reversal obligation. Never a K principal event.
 IF bonus>0 THEN
  INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
  VALUES(rid,'PointsMerchantRefund',rid,'PointsMerchantRefundProjectionRequested',1,jsonb_build_object('refundId',rid));
 END IF;
 UPDATE konektag.merchant_sales SET status='CANCELLED',updated_at=now()
 WHERE k_operation_id=c.k_operation_id AND previous_q+q=c.quantity AND status='CREATED';
 UPDATE konektag.merchant_points_bonuses SET status='reversed',reversed_at=now(),reversal_projection_status='pending'
 WHERE consumption_id=p_source AND previous_q+q=c.quantity;
 UPDATE konektag.merchant_settlements s SET points_bonus_review_required=true
 FROM konektag.merchant_settlement_sales l JOIN konektag.merchant_sales sale ON sale.id=l.sale_id
 WHERE s.id=l.settlement_id AND sale.k_operation_id=c.k_operation_id;
 RETURN r;
END; $$;

CREATE OR REPLACE FUNCTION konektag.refund_merchant_points(p_source UUID,p_key TEXT,p_actor UUID,p_quantity BIGINT,p_reason TEXT)
RETURNS konektag.points_merchant_refunds LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE; r konektag.points_merchant_refunds%ROWTYPE;
 t konektag.financial_transactions%ROWTYPE; f konektag.fee_credits%ROWTYPE; a RECORD;
 previous_q BIGINT; q BIGINT; base NUMERIC; bonus NUMERIC; fee NUMERIC; recovery NUMERIC:=0;
 rid UUID:=gen_random_uuid(); tid UUID:=gen_random_uuid();
BEGIN
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'POINTS_REFUND_SOURCE_NOT_FOUND'; END IF;
 IF c.k_operation_id IS NOT NULL THEN
  RETURN konektag.refund_link_k_points(p_source,p_key,p_actor,p_quantity,p_reason);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||c.party_id::text,0));
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=p_source FOR UPDATE;
 PERFORM id FROM konektag.merchant_sales WHERE transaction_id=c.monetary_transaction_id FOR UPDATE;
 SELECT * INTO r FROM konektag.points_merchant_refunds WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF r.consumption_id<>p_source OR r.actor_user_id<>p_actor OR r.requested_quantity IS DISTINCT FROM p_quantity OR r.reason<>p_reason
   THEN RAISE EXCEPTION 'POINTS_REFUND_REPLAY_CONFLICT'; END IF;
  RETURN r;
 END IF;
 SELECT COALESCE(sum(quantity),0) INTO previous_q FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 q:=COALESCE(p_quantity,c.quantity-previous_q);
 IF q<=0 OR previous_q+q>c.quantity THEN RAISE EXCEPTION 'POINTS_REFUND_EXCEEDS_REMAINING'; END IF;
 IF c.value_basis_version=2 THEN
  SELECT round(c.k_value_amount*(previous_q+q)/c.quantity,8)-COALESCE(sum(merchant_value),0),
   round(COALESCE((SELECT amount FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id),0)*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0),
   CASE WHEN c.cashback_amount IS NOT NULL
     THEN round(c.cashback_amount*(previous_q+q)/c.quantity,8)-COALESCE(sum(fee_credit_reversal),0) ELSE 0 END
  INTO base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 ELSE
  SELECT round(c.merchant_value*(previous_q+q)/c.quantity,8)-COALESCE(sum(merchant_value),0),
   CASE WHEN c.eligible THEN round(c.merchant_value*0.01*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0) ELSE 0 END,
   CASE WHEN c.eligible THEN round(c.merchant_value*0.0025*(previous_q+q)/c.quantity,8)-COALESCE(sum(fee_credit_reversal),0) ELSE 0 END
  INTO base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 END IF;
 SELECT * INTO f FROM konektag.fee_credits WHERE consumption_id=p_source FOR UPDATE;
 IF FOUND THEN
  FOR a IN SELECT x.operation_key FROM konektag.fee_credit_applications x JOIN konektag.fee_credit_uses u ON u.application_id=x.id
   WHERE u.fee_credit_id=f.id AND x.status='reserved' ORDER BY x.id
  LOOP PERFORM konektag.finish_fee_credit_application(a.operation_key,false); END LOOP;
  SELECT * INTO f FROM konektag.fee_credits WHERE id=f.id FOR UPDATE;
  recovery:=greatest(0,fee-f.remaining_amount);
  UPDATE konektag.fee_credits SET remaining_amount=greatest(0,remaining_amount-fee),reversed_amount=reversed_amount+fee,
   recovery_amount=recovery_amount+recovery,
   status=CASE WHEN remaining_amount>fee THEN 'available' WHEN recovery_amount+recovery>0 THEN 'recovery_required' ELSE 'cancelled' END,
   cancelled_at=CASE WHEN remaining_amount<=fee THEN now() ELSE cancelled_at END WHERE id=f.id;
 END IF;
 SELECT * INTO t FROM konektag.financial_transactions WHERE id=c.k_transaction_id;
 INSERT INTO konektag.financial_transactions(id,transaction_type,business_reference,idempotency_key,currency,status,
  legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,eligibility_decision)
 VALUES(tid,'refund',rid::text,'points-refund:'||p_key,'K','pending',NULL,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE,'ALLOWED');
 INSERT INTO konektag.points_merchant_refunds(id,consumption_id,idempotency_key,actor_user_id,reason,requested_quantity,
  quantity,merchant_value,bonus_reversal,fee_credit_reversal,fee_credit_recovery_pending,k_transaction_id)
 VALUES(rid,p_source,p_key,p_actor,p_reason,p_quantity,q,base,bonus,fee,recovery,tid) RETURNING * INTO r;
 INSERT INTO konektag.ledger_entries(transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,
 document_type,document_ref,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date)
 VALUES(tid,'K_ISSUANCE','debit','debit',NULL,q,'K','refund',rid::text,NULL,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE),
 (tid,'1000','credit','credit',c.party_id,q,'K','refund',rid::text,NULL,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE);
 UPDATE konektag.financial_transactions SET status='completed',completed_at=now() WHERE id=tid;
 INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
 VALUES(rid,'PointsMerchantRefund',rid,'PointsMerchantRefundProjectionRequested',1,jsonb_build_object('refundId',rid));
 UPDATE konektag.merchant_points_bonuses SET status='reversed',reversed_at=now(),reversal_projection_status='pending'
 WHERE consumption_id=p_source AND previous_q+q=c.quantity;
 UPDATE konektag.merchant_settlements s SET points_bonus_review_required=true
 FROM konektag.merchant_settlement_sales l JOIN konektag.merchant_sales sale ON sale.id=l.sale_id
 WHERE s.id=l.settlement_id AND sale.transaction_id=c.monetary_transaction_id;
 RETURN r;
END; $$;

CREATE OR REPLACE FUNCTION konektag.check_points_refund_proof()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r konektag.points_merchant_refunds%ROWTYPE; c konektag.points_merchant_consumptions%ROWTYPE; valid BOOLEAN;
BEGIN
 SELECT * INTO r FROM konektag.points_merchant_refunds WHERE id=NEW.id;
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=r.consumption_id;
 IF r.k_operation_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.k_operations k WHERE k.id=r.k_operation_id AND k.status='completed'
   AND k.operation_type='refund' AND k.party_id=c.party_id AND k.quantity=r.quantity AND k.source_operation_id=c.k_operation_id)
  OR (SELECT count(*) FROM konektag.ledger_entries e WHERE e.k_operation_id=r.k_operation_id AND e.document_ref=r.id::text)<>2
  THEN RAISE EXCEPTION 'POINTS_REFUND_PROOF_REQUIRED'; END IF;
  IF c.cashback_amount IS NOT NULL AND NOT EXISTS(SELECT 1 FROM konektag.fee_credits f WHERE f.consumption_id=c.id
   AND f.reversed_amount=(SELECT sum(fee_credit_reversal) FROM konektag.points_merchant_refunds WHERE consumption_id=c.id))
  THEN RAISE EXCEPTION 'FEE_CREDIT_REVERSAL_PROOF_REQUIRED'; END IF;
  RETURN NULL;
 END IF;
 SELECT count(*)=2 AND bool_and(e.amount=r.quantity AND e.currency='K' AND e.gl_scope='GLOBAL_USER_GL'
  AND e.document_ref=r.id::text AND ((e.account_code='1000' AND e.entry_side='credit' AND e.party_id=c.party_id)
   OR(e.account_code='K_ISSUANCE' AND e.entry_side='debit' AND e.party_id IS NULL))) INTO valid
 FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id=e.transaction_id
 WHERE t.id=r.k_transaction_id AND t.currency='K' AND t.status='completed';
 IF c.eligible AND NOT EXISTS(SELECT 1 FROM konektag.fee_credits f WHERE f.consumption_id=c.id AND f.reversed_amount=(SELECT sum(fee_credit_reversal) FROM konektag.points_merchant_refunds WHERE consumption_id=c.id)) THEN RAISE EXCEPTION 'FEE_CREDIT_REVERSAL_PROOF_REQUIRED'; END IF;
 IF valid IS DISTINCT FROM true OR (SELECT count(*) FROM konektag.outbox_events WHERE aggregate_id=r.id
 AND event_type='PointsMerchantRefundProjectionRequested')<>1 THEN RAISE EXCEPTION 'POINTS_REFUND_PROOF_REQUIRED'; END IF;
 RETURN NULL;
END; $$;

CREATE FUNCTION konektag.guard_link_k_refund_actor() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM konektag.points_merchant_consumptions c WHERE c.id=NEW.consumption_id
   AND (c.k_operation_id IS NULL)<>(NEW.k_operation_id IS NULL))
 THEN RAISE EXCEPTION 'POINTS_REFUND_PARENT_MISMATCH'; END IF;
 IF NEW.k_operation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM konektag.points_merchant_consumptions c JOIN konektag.merchant_profiles m ON m.id=c.merchant_profile_id
   JOIN konektag.users u ON u.id=NEW.actor_user_id
  WHERE c.id=NEW.consumption_id AND c.k_operation_id IS NOT NULL AND u.deleted_at IS NULL AND (u.role='admin' OR m.user_id=u.id))
 THEN RAISE EXCEPTION 'POINTS_REFUND_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER link_k_refund_actor BEFORE INSERT ON konektag.points_merchant_refunds
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_link_k_refund_actor();

-- Grant only to roles already entitled to write the historical K ledger.
REVOKE ALL ON FUNCTION konektag.refund_link_k_points(uuid,text,uuid,bigint,text) FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
  WHERE table_schema='konektag' AND table_name='ledger_entries' AND privilege_type='INSERT' AND grantee<>'PUBLIC'
 LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON konektag.k_operations TO %I',r.grantee);
  EXECUTE format('GRANT EXECUTE ON FUNCTION konektag.refund_link_k_points(uuid,text,uuid,bigint,text) TO %I',r.grantee);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION konektag.project_k_wallet_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tx uuid; e record;
BEGIN
 IF TG_TABLE_NAME='ledger_entries' THEN
  IF NEW.k_operation_id IS NOT NULL THEN RETURN NULL; END IF;
  tx:=NEW.transaction_id;
 ELSE
  IF TG_OP='UPDATE' AND (OLD.status=NEW.status OR OLD.status IN ('completed','reversed')) THEN RETURN NULL; END IF;
  tx:=NEW.id;
 END IF;
 FOR e IN SELECT l.*,t.transaction_type FROM konektag.ledger_entries l
 JOIN konektag.financial_transactions t ON t.id=l.transaction_id
 WHERE l.transaction_id=tx AND l.party_id IS NOT NULL AND l.account_code='1000' AND l.currency='K'
 AND l.gl_scope='GLOBAL_USER_GL' AND t.status IN ('completed','reversed') ORDER BY l.party_id,l.id
 LOOP
  IF e.amount<=0 OR e.amount<>trunc(e.amount) THEN RAISE EXCEPTION 'INVALID_K_WALLET_QUANTITY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||e.party_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM konektag.k_wallet_entries WHERE source_type='legacy_ledger' AND source_id=e.id::text) THEN
   INSERT INTO konektag.k_wallet_entries(party_id,operation_id,operation_type,direction,quantity_k,source_type,source_id,created_at)
   VALUES(e.party_id,e.transaction_id,CASE WHEN e.transaction_type='acquisition' THEN 'purchase'
     WHEN e.transaction_type='consumption' THEN 'payment' WHEN e.transaction_type IN ('refund','reversal') THEN 'refund'
     WHEN e.transaction_type='k_send' THEN 'k_send' WHEN e.document_type='Cashback' THEN 'cashback' ELSE 'adjustment' END,
     e.entry_side,e.amount::bigint,'legacy_ledger',e.id::text,e.created_at);
  END IF;
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION konektag.guard_k_wallet_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.source_type='k_operation_ledger' OR (TG_OP='UPDATE' AND NEW.source_type='k_operation_ledger')
   THEN RAISE EXCEPTION 'K_WALLET_ENTRY_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF NEW.source_type='k_operation_ledger' AND NOT EXISTS(
  SELECT 1 FROM konektag.ledger_entries e JOIN konektag.k_operations k ON k.id=e.k_operation_id
  WHERE e.id::text=NEW.source_id AND k.id=NEW.operation_id AND k.status='completed'
   AND e.party_id=NEW.party_id AND e.account_code='1000' AND e.entry_side=NEW.direction AND e.amount=NEW.quantity_k
   AND NEW.operation_type=CASE WHEN k.operation_type='refund' THEN 'refund' ELSE 'payment' END
   AND NEW.counterparty_party_id IS NULL)
 THEN RAISE EXCEPTION 'K_WALLET_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER k_wallet_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON konektag.k_wallet_entries
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_k_wallet_projection();

CREATE FUNCTION konektag.check_link_k_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.k_operation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM konektag.k_operations k JOIN konektag.points_merchant_consumptions c ON c.k_operation_id=k.id
   JOIN konektag.parties p ON p.id=k.party_id JOIN konektag.users u ON u.keycloak_id=p.keycloak_id
   JOIN konektag.merchant_sales s ON s.k_operation_id=k.id
  WHERE k.id=NEW.k_operation_id AND k.status='completed' AND k.operation_type='merchant_consumption'
   AND c.merchant_profile_id=NEW.merchant_profile_id AND c.transaction_amount_minor=NEW.amount
   AND c.transaction_currency=NEW.currency AND c.quantity=NEW.quantity_k AND u.id=NEW.payer_user_id
   AND c.operation_key='LINK-'||NEW.public_id AND s.merchant_profile_id=c.merchant_profile_id
   AND s.gross_amount=NEW.amount AND s.currency=NEW.currency)
 THEN RAISE EXCEPTION 'LINK_K_COMPLETION_PROOF_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER link_k_completion AFTER INSERT OR UPDATE ON konektag.checkout_intents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_link_k_completion();
COMMIT;
