BEGIN;
CREATE TABLE konektag.points_merchant_refunds (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 consumption_id UUID NOT NULL REFERENCES konektag.points_merchant_consumptions(id),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)>0),
 actor_user_id UUID NOT NULL REFERENCES konektag.users(id),
 reason TEXT NOT NULL CHECK(length(trim(reason))>0),
 requested_quantity BIGINT CHECK(requested_quantity>0),
 quantity BIGINT NOT NULL CHECK(quantity>0),
 merchant_value NUMERIC(24,8) NOT NULL CHECK(merchant_value>=0),
 bonus_reversal NUMERIC(24,8) NOT NULL CHECK(bonus_reversal>=0),
 fee_credit_reversal NUMERIC(24,8) NOT NULL CHECK(fee_credit_reversal>=0),
 fee_credit_recovery_pending NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK(fee_credit_recovery_pending>=0),
 k_transaction_id UUID NOT NULL UNIQUE REFERENCES konektag.financial_transactions(id),
 debt_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
 bonus_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
 projection_status TEXT NOT NULL DEFAULT 'pending' CHECK(projection_status IN('pending','pending_mapping','projected','error')),
 projection_error TEXT,
 retention_projection_status TEXT NOT NULL DEFAULT 'pending_rule' CHECK(retention_projection_status IN('pending_rule','resolved')),
 retention_review_reason TEXT NOT NULL DEFAULT 'Commission and tax reversal policy requires approved mapping',
 settlement_adjustment_status TEXT NOT NULL DEFAULT 'pending_review' CHECK(settlement_adjustment_status IN('pending_review','resolved')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX points_refunds_source ON konektag.points_merchant_refunds(consumption_id);
CREATE INDEX points_refunds_recovery ON konektag.points_merchant_refunds(created_at) WHERE fee_credit_recovery_pending>0 OR settlement_adjustment_status='pending_review';
ALTER TABLE konektag.fee_credits ADD COLUMN reversed_amount NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK(reversed_amount>=0 AND reversed_amount<=initial_amount);
CREATE FUNCTION konektag.guard_points_refund()
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
 IF NOT EXISTS(SELECT 1 FROM konektag.users u JOIN konektag.merchant_profiles m ON m.id=c.merchant_profile_id
  WHERE u.id=NEW.actor_user_id AND u.deleted_at IS NULL AND (u.role='admin' OR m.user_id=u.id))
 THEN RAISE EXCEPTION 'POINTS_REFUND_FORBIDDEN'; END IF;
 SELECT COALESCE(sum(quantity),0),COALESCE(sum(merchant_value),0),COALESCE(sum(bonus_reversal),0),COALESCE(sum(fee_credit_reversal),0)
 INTO q,base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=c.id;
 IF q+NEW.quantity>c.quantity THEN RAISE EXCEPTION 'POINTS_REFUND_EXCEEDS_REMAINING'; END IF;
 IF NEW.merchant_value<>round(c.merchant_value*(q+NEW.quantity)/c.quantity,8)-base
 OR NEW.bonus_reversal<>(CASE WHEN c.eligible THEN round(c.merchant_value*0.01*(q+NEW.quantity)/c.quantity,8)-bonus ELSE 0 END)
 OR NEW.fee_credit_reversal<>(CASE WHEN c.eligible THEN round(c.merchant_value*0.0025*(q+NEW.quantity)/c.quantity,8)-fee ELSE 0 END)
 THEN RAISE EXCEPTION 'POINTS_REFUND_PROPORTION_MISMATCH'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER points_refund_guard BEFORE INSERT OR UPDATE OR DELETE ON konektag.points_merchant_refunds FOR EACH ROW EXECUTE FUNCTION konektag.guard_points_refund();
CREATE FUNCTION konektag.check_points_refund_proof()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r konektag.points_merchant_refunds%ROWTYPE; c konektag.points_merchant_consumptions%ROWTYPE; valid BOOLEAN;
BEGIN
 SELECT * INTO r FROM konektag.points_merchant_refunds WHERE id=NEW.id;
 SELECT * INTO c FROM konektag.points_merchant_consumptions WHERE id=r.consumption_id;
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
CREATE CONSTRAINT TRIGGER points_refund_proof AFTER INSERT ON konektag.points_merchant_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.check_points_refund_proof();
CREATE UNIQUE INDEX points_refund_outbox_unique ON konektag.outbox_events(aggregate_id,event_type) WHERE event_type='PointsMerchantRefundProjectionRequested';
CREATE OR REPLACE FUNCTION konektag.check_fee_credit_conservation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE f konektag.fee_credits%ROWTYPE; used NUMERIC;
BEGIN
 SELECT * INTO f FROM konektag.fee_credits WHERE id=NEW.id;
 IF f.reversed_amount<>(SELECT COALESCE(sum(fee_credit_reversal),0) FROM konektag.points_merchant_refunds WHERE consumption_id=f.consumption_id) THEN RAISE EXCEPTION 'FEE_CREDIT_REVERSAL_PROOF_REQUIRED'; END IF;
 IF f.status IN('available','reserved','consumed') THEN
  SELECT COALESCE(sum(u.amount),0) INTO used FROM konektag.fee_credit_uses u JOIN konektag.fee_credit_applications a ON a.id=u.application_id
   WHERE u.fee_credit_id=f.id AND a.status IN('reserved','applied');
  IF f.remaining_amount<>greatest(0,f.initial_amount-f.reversed_amount-used) THEN RAISE EXCEPTION 'FEE_CREDIT_CONSERVATION_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE FUNCTION konektag.refund_merchant_points(p_source UUID,p_key TEXT,p_actor UUID,p_quantity BIGINT,p_reason TEXT)
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
 SELECT round(c.merchant_value*(previous_q+q)/c.quantity,8)-COALESCE(sum(merchant_value),0),
 CASE WHEN c.eligible THEN round(c.merchant_value*0.01*(previous_q+q)/c.quantity,8)-COALESCE(sum(bonus_reversal),0) ELSE 0 END,
 CASE WHEN c.eligible THEN round(c.merchant_value*0.0025*(previous_q+q)/c.quantity,8)-COALESCE(sum(fee_credit_reversal),0) ELSE 0 END
 INTO base,bonus,fee FROM konektag.points_merchant_refunds WHERE consumption_id=p_source;
 -- Release whole unconsumed applications first; their quoted price cannot be silently altered.
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
 -- Historical settlements remain immutable; recovery/repricing must be reviewed explicitly.
 UPDATE konektag.merchant_settlements s SET points_bonus_review_required=true
 FROM konektag.merchant_settlement_sales l JOIN konektag.merchant_sales sale ON sale.id=l.sale_id
 WHERE s.id=l.settlement_id AND sale.transaction_id=c.monetary_transaction_id;
 RETURN r;
END; $$;
CREATE OR REPLACE VIEW konektag.points_merchant_settlement_details AS
 SELECT c.id AS consumption_id,c.merchant_profile_id,c.currency,c.merchant_value,c.status AS consumption_status,
 COALESCE(s.commission_amount,0) AS commission_amount,COALESCE(s.tax_amount,0) AS tax_amount,
 CASE WHEN b.status='earned' THEN b.amount-COALESCE(r.bonus,0) ELSE 0 END AS bonus_amount,
 CASE WHEN c.status='completed' THEN c.merchant_value-COALESCE(r.base,0)+CASE WHEN b.status='earned' THEN b.amount-COALESCE(r.bonus,0) ELSE 0 END ELSE 0 END AS gross_entitlement,
 CASE WHEN EXISTS(SELECT 1 FROM konektag.points_merchant_refunds pending WHERE pending.consumption_id=c.id AND pending.retention_projection_status='pending_rule') THEN NULL
 WHEN c.status='completed' THEN COALESCE(s.net_amount,0)-COALESCE(r.base,0)+CASE WHEN b.status='earned' THEN b.amount-COALESCE(r.bonus,0) ELSE 0 END ELSE 0 END AS net_due
 FROM konektag.points_merchant_consumptions c JOIN konektag.merchant_sales s ON s.transaction_id=c.monetary_transaction_id
 LEFT JOIN konektag.merchant_points_bonuses b ON b.consumption_id=c.id
 LEFT JOIN LATERAL(SELECT sum(merchant_value) base,sum(bonus_reversal) bonus FROM konektag.points_merchant_refunds WHERE consumption_id=c.id) r ON true;
REVOKE ALL ON FUNCTION konektag.refund_merchant_points(UUID,TEXT,UUID,BIGINT,TEXT),konektag.guard_points_refund(),konektag.check_points_refund_proof() FROM PUBLIC;
COMMIT;
