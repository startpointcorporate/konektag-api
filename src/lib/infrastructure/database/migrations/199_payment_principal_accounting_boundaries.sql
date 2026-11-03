BEGIN;

-- Link/QR payment has no commission. The nullable columns come from migration 182
-- and retain historical facts only; payment must leave them NULL.
-- Shared compensation tables below are used by settlement-service, not payment.
ALTER TABLE konektag.points_merchant_consumptions DROP CONSTRAINT merchant_commission_scope;
ALTER TABLE konektag.points_merchant_consumptions ADD CONSTRAINT merchant_commission_scope CHECK (
 (merchant_commission_rate_bps IS NULL AND merchant_commission_rule_id IS NULL AND merchant_commission_amount_exact IS NULL)
 OR (payment_rail IN ('qr','payment_link') AND merchant_commission_rate_bps IS NOT NULL
     AND merchant_commission_rule_id IS NOT NULL AND merchant_commission_amount_exact IS NOT NULL)
);

-- Explicitly approved per-merchant accounting mappings. No country/corridor fallback.
CREATE TABLE konektag.merchant_accounting_mappings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
 revenue_type TEXT NOT NULL CHECK (revenue_type IN ('merchant_commission','merchant_bonus','fee')),
 currency VARCHAR(3) NOT NULL,
 legal_entity_id UUID NOT NULL REFERENCES konektag.legal_entities(id),
 debit_account TEXT NOT NULL CHECK (btrim(debit_account)<>''),
 credit_account TEXT NOT NULL CHECK (btrim(credit_account)<>''),
 cost_center TEXT NOT NULL CHECK (btrim(cost_center)<>''),
 approval_reference TEXT NOT NULL CHECK (btrim(approval_reference)<>''),
 approved_by UUID NOT NULL REFERENCES konektag.users(id),
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_merchant_accounting_mapping_active ON konektag.merchant_accounting_mappings
 (merchant_profile_id,revenue_type,currency) WHERE active;

-- Durable obligations are committed with their source, even without a mapping.
-- Payment creates neither bonus nor commission obligations. These tables support
-- compensation and recovery of historical accounting facts only.
CREATE TABLE konektag.konektag_revenue_attributions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 source_type VARCHAR(40) NOT NULL,
 source_id VARCHAR(255) NOT NULL,
 merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
 revenue_type VARCHAR(40) NOT NULL CHECK (revenue_type IN ('merchant_commission','merchant_bonus','fee')),
 legal_entity_id UUID REFERENCES konektag.legal_entities(id),
 mapping_id UUID REFERENCES konektag.merchant_accounting_mappings(id),
 currency VARCHAR(3) NOT NULL,
 amount_exact NUMERIC(24,8) NOT NULL CHECK (amount_exact>0),
 rule_id UUID REFERENCES konektag.merchant_payment_commission_rules(id),
 status VARCHAR(30) NOT NULL DEFAULT 'PENDING_MAPPING'
  CHECK (status IN ('PENDING_MAPPING','PENDING_PROJECTION','PROJECTED','REVERSAL_PENDING','REVERSED','ERROR')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 projected_at TIMESTAMPTZ,
 reversed_at TIMESTAMPTZ,
 UNIQUE(source_type,source_id,revenue_type),
 CHECK (mapping_id IS NULL OR legal_entity_id IS NOT NULL)
);
CREATE INDEX idx_revenue_attribution_owner_status ON konektag.konektag_revenue_attributions(legal_entity_id,status);

CREATE TABLE konektag.konektag_accounting_projections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 attribution_id UUID NOT NULL REFERENCES konektag.konektag_revenue_attributions(id),
 refund_id UUID REFERENCES konektag.points_merchant_refunds(id),
 projection_key TEXT NOT NULL UNIQUE,
 amount_exact NUMERIC(24,8) NOT NULL CHECK (amount_exact>0),
 is_reversal BOOLEAN NOT NULL DEFAULT false,
 voucher_reference TEXT,
 projected_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION konektag.guard_revenue_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REVENUE_ATTRIBUTION_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.source_type,NEW.source_id,NEW.merchant_profile_id,NEW.revenue_type,NEW.currency,NEW.amount_exact,NEW.rule_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.source_type,OLD.source_id,OLD.merchant_profile_id,OLD.revenue_type,OLD.currency,OLD.amount_exact,OLD.rule_id,OLD.created_at)
   OR (OLD.legal_entity_id IS NOT NULL AND NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id)
   OR (OLD.mapping_id IS NOT NULL AND NEW.mapping_id IS DISTINCT FROM OLD.mapping_id)
  THEN RAISE EXCEPTION 'REVENUE_ATTRIBUTION_IMMUTABLE'; END IF;
 END IF;
 IF NEW.legal_entity_id IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM konektag.legal_entities WHERE id=NEW.legal_entity_id AND status='APPROVED' AND deleted_at IS NULL)
  THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_NOT_APPROVED'; END IF;
 END IF;
 IF NEW.mapping_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM konektag.merchant_accounting_mappings m WHERE m.id=NEW.mapping_id
   AND m.merchant_profile_id=NEW.merchant_profile_id AND m.currency=NEW.currency
   AND m.revenue_type=NEW.revenue_type AND m.legal_entity_id=NEW.legal_entity_id
 ) THEN RAISE EXCEPTION 'ACCOUNTING_MAPPING_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revenue_attribution_guard BEFORE INSERT OR UPDATE OR DELETE ON konektag.konektag_revenue_attributions
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_revenue_attribution();

-- A mapping already used is frozen. Retire it and create a new approval instead.
CREATE OR REPLACE FUNCTION konektag.guard_merchant_accounting_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active')
 THEN RAISE EXCEPTION 'ACCOUNTING_MAPPING_IMMUTABLE'; END IF;
 IF NEW.active AND NOT EXISTS (SELECT 1 FROM konektag.legal_entities WHERE id=NEW.legal_entity_id AND status='APPROVED' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'KONEKTAG_ACCOUNTING_OWNER_NOT_APPROVED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER merchant_accounting_mapping_guard BEFORE INSERT OR UPDATE ON konektag.merchant_accounting_mappings
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_merchant_accounting_mapping();

-- Compensation freezes the selected rule independently from the original payment.
CREATE TABLE konektag.merchant_settlement_commissions (
 settlement_id UUID NOT NULL REFERENCES konektag.merchant_settlements(id),
 sale_id UUID NOT NULL REFERENCES konektag.merchant_sales(id),
 consumption_id UUID NOT NULL REFERENCES konektag.points_merchant_consumptions(id),
 rule_id UUID NOT NULL REFERENCES konektag.merchant_payment_commission_rules(id),
 percentage_bps INTEGER NOT NULL CHECK (percentage_bps BETWEEN 0 AND 10000),
 basis_amount NUMERIC(24,8) NOT NULL CHECK (basis_amount>=0),
 amount_exact NUMERIC(24,8) NOT NULL CHECK (amount_exact>=0),
 currency VARCHAR(3) NOT NULL,
 PRIMARY KEY(settlement_id,consumption_id)
);
CREATE OR REPLACE FUNCTION konektag.guard_settlement_commission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'SETTLEMENT_COMMISSION_IMMUTABLE';
END $$;
CREATE TRIGGER settlement_commission_guard BEFORE UPDATE OR DELETE ON konektag.merchant_settlement_commissions
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_settlement_commission();

-- Every obligation has an atomic, deduplicated projection request.
CREATE OR REPLACE FUNCTION konektag.enqueue_revenue_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
 VALUES(NEW.id,'KonektagRevenueAttribution',NEW.id,'KonektagRevenueProjectionRequested',1,jsonb_build_object('attributionId',NEW.id));
 RETURN NEW;
END $$;
CREATE TRIGGER revenue_attribution_outbox AFTER INSERT ON konektag.konektag_revenue_attributions
 FOR EACH ROW EXECUTE FUNCTION konektag.enqueue_revenue_attribution();

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

CREATE UNIQUE INDEX uq_http_idem_actor_no_entity
 ON konektag.http_idempotency_requests(actor_type,actor_id,route_key,idempotency_key)
 WHERE actor_type IS NOT NULL AND legal_entity_id IS NULL AND route_key IS NOT NULL;

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
  IF TG_TABLE_NAME='fee_credits' AND NOT c.eligible THEN RAISE EXCEPTION 'POINTS_BENEFIT_NOT_ELIGIBLE'; END IF;
  IF c.value_basis_version=2 THEN
    IF TG_TABLE_NAME='fee_credits' THEN
      IF c.payment_rail NOT IN ('qr','payment_link') OR c.cashback_amount IS NULL
        OR NEW.party_id<>c.party_id OR NEW.currency<>c.cashback_currency
        OR NEW.rate<>c.cashback_rate_bps::numeric/10000 OR NEW.initial_amount<>c.cashback_amount
      THEN RAISE EXCEPTION 'FEE_CREDIT_SOURCE_MISMATCH'; END IF;
    ELSE
      IF c.payment_rail NOT IN ('qr','payment_link')
        OR NEW.merchant_profile_id<>c.merchant_profile_id
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
    IF NEW.merchant_profile_id<>c.merchant_profile_id
      OR NEW.amount<>c.merchant_value*0.01
    THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END; $$;


CREATE OR REPLACE FUNCTION konektag.derive_v3_gl_scope() RETURNS trigger AS $$
DECLARE entity_code text;
BEGIN
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


-- Refund functions from 181: preserve replay, legacy basis, fee credits and settlement review.
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
   OR NEW.bonus_reversal<>(round(COALESCE((SELECT amount FROM konektag.merchant_points_bonuses WHERE consumption_id=c.id),0)*(q+NEW.quantity)/c.quantity,8)-bonus)
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


-- Preserve historical bonus facts and recover their durable accounting obligation.
-- Never infer an owner from the principal or a country. The worker also respects
-- an owner already recorded on the historical bonus when selecting its mapping.
INSERT INTO konektag.konektag_revenue_attributions
 (source_type,source_id,merchant_profile_id,revenue_type,currency,amount_exact)
SELECT 'merchant_consumption',c.operation_key,c.merchant_profile_id,'merchant_bonus',b.currency,b.amount
FROM konektag.merchant_points_bonuses b JOIN konektag.points_merchant_consumptions c ON c.id=b.consumption_id
WHERE b.amount>0 ON CONFLICT(source_type,source_id,revenue_type) DO NOTHING;

COMMIT;
