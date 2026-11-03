BEGIN;

-- Merchant bonus is a settlement benefit, not Points K:
--   * only QR Pay / Link Pay;
--   * 1% of the commercial transaction amount;
--   * same currency as the merchant sale;
--   * paid through merchant settlement (merchant has no K wallet).

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
  IF NOT c.eligible THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  IF c.value_basis_version=2 THEN
    IF TG_TABLE_NAME='fee_credits' THEN
      IF c.payment_rail NOT IN ('qr','payment_link') OR c.cashback_amount IS NULL
        OR NEW.party_id<>c.party_id OR NEW.currency<>c.cashback_currency
        OR NEW.rate<>c.cashback_rate_bps::numeric/10000 OR NEW.initial_amount<>c.cashback_amount
      THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
    ELSE
      IF c.payment_rail NOT IN ('qr','payment_link')
        OR NEW.merchant_profile_id<>c.merchant_profile_id OR NEW.legal_entity_id<>c.legal_entity_id
        OR NEW.currency<>c.transaction_currency OR NEW.amount<>c.transaction_amount_minor*0.01
      THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF c.currency<>NEW.currency THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  IF TG_TABLE_NAME='fee_credits' THEN
    IF c.payment_rail NOT IN ('qr','payment_link') OR c.cashback_rate_bps IS NULL
      OR NEW.party_id<>c.party_id OR NEW.rate<>c.cashback_rate_bps::numeric/10000
      OR NEW.initial_amount<>c.merchant_value*c.cashback_rate_bps::numeric/10000
    THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
  ELSE
    IF NEW.merchant_profile_id<>c.merchant_profile_id OR NEW.legal_entity_id<>c.legal_entity_id
      OR NEW.amount<>c.merchant_value*0.01
    THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END; $$;

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
 IF c.value_basis_version=2 THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.merchant_sales s WHERE s.transaction_id=c.monetary_transaction_id
    AND s.merchant_profile_id=c.merchant_profile_id AND s.legal_entity_id=c.legal_entity_id
    AND s.currency=c.transaction_currency AND s.gross_amount=c.transaction_amount_minor)
  THEN RAISE EXCEPTION 'POINTS_TRANSACTION_MISMATCH'; END IF;
  IF c.cashback_amount IS NOT NULL THEN
   IF NOT c.eligible OR (SELECT count(*) FROM konektag.fee_credits WHERE consumption_id=c.id)<>1
   THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
  ELSIF EXISTS(SELECT 1 FROM konektag.fee_credits WHERE consumption_id=c.id)
  THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  IF c.eligible AND c.payment_rail IN ('qr','payment_link') THEN
   IF (SELECT count(*) FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)<>1
     OR (SELECT count(*) FROM konektag.outbox_events WHERE aggregate_id=c.id AND event_type='PointsMerchantBonusProjectionRequested')<>1
   THEN RAISE EXCEPTION 'POINTS_BENEFITS_INCOMPLETE'; END IF;
  ELSIF EXISTS(SELECT 1 FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id)
  THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  RETURN NULL;
 END IF;
 SELECT least(c.quantity,COALESCE(o.subtotal_amount,s.gross_amount)) INTO v_base
 FROM konektag.merchant_sales s JOIN konektag.api_payment_wallet_reservations r ON r.id=c.reservation_id
 LEFT JOIN konektag.api_payment_orders o ON o.id=r.payment_order_id
 WHERE s.transaction_id=c.monetary_transaction_id AND s.merchant_profile_id=c.merchant_profile_id
   AND s.legal_entity_id=c.legal_entity_id AND s.currency=c.currency;
 IF v_base IS NULL OR v_base<>c.merchant_value THEN RAISE EXCEPTION 'POINTS_MERCHANT_VALUE_MISMATCH'; END IF;
 RETURN NULL;
END; $$;

-- Settlement projection now has one monetary dimension: the merchant sale currency.
-- A version 2 bonus is attributed only to QR Pay / Link Pay; version 1 rows keep their historical rules.
CREATE OR REPLACE VIEW konektag.points_merchant_settlement_details AS
 SELECT c.id AS consumption_id,c.merchant_profile_id,
   CASE WHEN c.value_basis_version=2 THEN c.transaction_currency ELSE c.currency END AS currency,
   (CASE WHEN c.value_basis_version=2 THEN c.transaction_amount_minor ELSE c.merchant_value END)::NUMERIC(24,8) AS merchant_value,
   c.status AS consumption_status,
   COALESCE(s.commission_amount,0) AS commission_amount,COALESCE(s.tax_amount,0) AS tax_amount,
   bn.amount AS bonus_amount,
   CASE WHEN c.status='completed' THEN
     (CASE WHEN c.value_basis_version=2 THEN c.transaction_amount_minor ELSE c.merchant_value END)
     -COALESCE(r.transaction_base,0)+bn.amount
     ELSE 0 END AS gross_entitlement,
   CASE WHEN EXISTS(SELECT 1 FROM konektag.points_merchant_refunds pending
      WHERE pending.consumption_id=c.id AND pending.retention_projection_status='pending_rule') THEN NULL
     WHEN c.status='completed' THEN COALESCE(s.net_amount,0)-COALESCE(r.transaction_base,0)+bn.amount ELSE 0 END AS net_due
 FROM konektag.points_merchant_consumptions c
 JOIN konektag.merchant_sales s ON s.transaction_id=c.monetary_transaction_id
 LEFT JOIN konektag.merchant_points_bonuses b ON b.consumption_id=c.id
 LEFT JOIN LATERAL(
   SELECT
     CASE WHEN c.value_basis_version=2
       THEN round(c.transaction_amount_minor*COALESCE(sum(x.quantity),0)/c.quantity,8)
       ELSE COALESCE(sum(x.merchant_value),0) END AS transaction_base,
     COALESCE(sum(x.bonus_reversal),0) AS bonus
   FROM konektag.points_merchant_refunds x WHERE x.consumption_id=c.id
 ) r ON true
 CROSS JOIN LATERAL(
   SELECT CASE WHEN b.status='earned' AND (c.value_basis_version=1 OR c.payment_rail IN ('qr','payment_link'))
     THEN b.amount-COALESCE(r.bonus,0) ELSE 0 END AS amount
 ) bn;

-- Version-2 refund guards keep three dimensions separate: K value (merchant_value legacy mirror),
-- local-currency merchant bonus, and EUR cashback fee credit.
CREATE OR REPLACE FUNCTION konektag.guard_points_refund()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c konektag.points_merchant_consumptions%ROWTYPE; q BIGINT; base NUMERIC; bonus NUMERIC; fee NUMERIC;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'POINTS_REFUND_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'debt_transaction_id'-'bonus_transaction_id'-'projection_status'-'projection_error'-'settlement_adjustment_status'-'retention_projection_status'-'retention_review_reason')
   IS DISTINCT FROM (to_jsonb(OLD)-'debt_transaction_id'-'bonus_transaction_id'-'projection_status'-'projection_error'-'settlement_adjustment_status'-'retention_projection_status'-'retention_review_reason')
   THEN RAISE EXCEPTION 'POINTS_REFUND_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=NEW.consumption_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||c.party_id::text,0));
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=NEW.consumption_id FOR UPDATE;
 IF c.status<>'completed' THEN RAISE EXCEPTION 'POINTS_REFUND_SOURCE_NOT_ACTIVE'; END IF;
 SELECT COALESCE(sum(quantity),0),COALESCE(sum(merchant_value),0),COALESCE(sum(bonus_reversal),0),COALESCE(sum(fee_credit_reversal),0)
 INTO q,base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=c.id;
 IF q+NEW.quantity>c.quantity THEN RAISE EXCEPTION 'POINTS_REFUND_EXCEEDS_REMAINING'; END IF;
 IF c.value_basis_version=2 THEN
  IF NEW.merchant_value<>round(c.k_value_amount*(q+NEW.quantity)/c.quantity,8)-base
   OR NEW.bonus_reversal<>(CASE WHEN c.eligible AND c.payment_rail IN ('qr','payment_link')
      THEN round(c.transaction_amount_minor*0.01*(q+NEW.quantity)/c.quantity,8)-bonus ELSE 0 END)
   OR NEW.fee_credit_reversal<>(CASE WHEN c.cashback_amount IS NOT NULL
      THEN round(c.cashback_amount*(q+NEW.quantity)/c.quantity,8)-fee ELSE 0 END)
  THEN RAISE EXCEPTION 'POINTS_REFUND_PROPORTION_MISMATCH'; END IF;
 ELSE
  IF NEW.merchant_value<>round(c.merchant_value*(q+NEW.quantity)/c.quantity,8)-base
   OR NEW.bonus_reversal<>(CASE WHEN c.eligible THEN round(c.merchant_value*0.01*(q+NEW.quantity)/c.quantity,8)-bonus ELSE 0 END)
   OR NEW.fee_credit_reversal<>(CASE WHEN c.eligible THEN round(c.merchant_value*0.0025*(q+NEW.quantity)/c.quantity,8)-fee ELSE 0 END)
  THEN RAISE EXCEPTION 'POINTS_REFUND_PROPORTION_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
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
   CASE WHEN c.eligible AND c.payment_rail IN ('qr','payment_link')
     THEN round(c.transaction_amount_minor*0.01*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0) ELSE 0 END,
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
 VALUES(tid,'refund',rid::text,'points-refund:'||p_key,'K','pending',c.legal_entity_id,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE,'ALLOWED');
 INSERT INTO konektag.points_merchant_refunds(id,consumption_id,idempotency_key,actor_user_id,reason,requested_quantity,
  quantity,merchant_value,bonus_reversal,fee_credit_reversal,fee_credit_recovery_pending,k_transaction_id)
 VALUES(rid,p_source,p_key,p_actor,p_reason,p_quantity,q,base,bonus,fee,recovery,tid) RETURNING * INTO r;
 INSERT INTO konektag.ledger_entries(transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,
 document_type,document_ref,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date)
 VALUES(tid,'K_ISSUANCE','debit','debit',NULL,q,'K','refund',rid::text,c.legal_entity_id,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE),
 (tid,'1000','credit','credit',c.party_id,q,'K','refund',rid::text,c.legal_entity_id,t.corridor_id,rid::text,t.regulatory_profile_id,CURRENT_DATE);
 UPDATE konektag.financial_transactions SET status='completed',completed_at=now() WHERE id=tid;
 INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
 VALUES(rid,'PointsMerchantRefund',rid,'PointsMerchantRefundProjectionRequested',1,jsonb_build_object('refundId',rid));
 UPDATE konektag.merchant_settlements s SET points_bonus_review_required=true
 FROM konektag.merchant_settlement_sales l JOIN konektag.merchant_sales sale ON sale.id=l.sale_id
 WHERE s.id=l.settlement_id AND sale.transaction_id=c.monetary_transaction_id;
 RETURN r;
END; $$;

COMMIT;
