-- Payment principal (P2P / Send K / Link Pay / QR Pay) is independent from
-- Konektag Legal Entities. Legal Entity remains an accounting attribution for
-- Konektag commissions, fees, settlements and genuine intercompany flows.
BEGIN;

ALTER TABLE konektag.regulatory_profiles ALTER COLUMN legal_entity_id DROP NOT NULL;
ALTER TABLE konektag.merchant_sales ALTER COLUMN legal_entity_id DROP NOT NULL;
ALTER TABLE konektag.points_merchant_consumptions ALTER COLUMN legal_entity_id DROP NOT NULL;
ALTER TABLE konektag.merchant_points_bonuses ALTER COLUMN legal_entity_id DROP NOT NULL;

-- Finalized principal operations keep their operational/regulatory dimensions,
-- but do not require a Konektag accounting owner.
ALTER TABLE konektag.financial_transactions DROP CONSTRAINT IF EXISTS ck_finalized_dimensions;
ALTER TABLE konektag.financial_transactions ADD CONSTRAINT ck_finalized_dimensions CHECK (
  status NOT IN ('completed','reversed') OR (
    corridor_id IS NOT NULL AND operation_id IS NOT NULL
    AND regulatory_profile_id IS NOT NULL AND currency IS NOT NULL
    AND value_date IS NOT NULL AND eligibility_decision IS NOT NULL
    AND (
      transaction_type IN ('consumption','k_send','qr_payment','link_payment','refund')
      OR legal_entity_id IS NOT NULL
    )
  )
) NOT VALID;

-- User/K principal entries are global wallet entries. Company GL entries still
-- require an explicit, approved Konektag Legal Entity.
CREATE OR REPLACE FUNCTION konektag.derive_v3_gl_scope() RETURNS trigger AS $$
DECLARE entity_code text;
BEGIN
  IF NEW.transaction_id IS NULL OR NEW.operation_id IS NULL THEN
    NEW.legacy_classification := COALESCE(NEW.legacy_classification,'REQUIRES_RECONCILIATION');
    RETURN NEW;
  END IF;
  IF NEW.currency IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0
     OR NEW.entry_side IS NULL OR NEW.account_code IS NULL THEN
    RAISE EXCEPTION 'V3 ledger entry requires currency, positive amount, side, account and operation identity';
  END IF;

  IF NEW.account_code IN ('1000','K_ISSUANCE') THEN
    NEW.gl_scope := 'GLOBAL_USER_GL';
    NEW.legacy_classification := NULL;
    RETURN NEW;
  END IF;

  IF NEW.legal_entity_id IS NULL THEN
    -- Commercial principal is not a Konektag company GL attribution.
    NEW.gl_scope := NULL;
    NEW.legacy_classification := 'PRINCIPAL_NO_ENTITY';
    RETURN NEW;
  END IF;

  SELECT code INTO entity_code FROM konektag.legal_entities
   WHERE id=NEW.legal_entity_id AND deleted_at IS NULL;
  IF entity_code NOT IN ('KTG-FR','KTG-CG') THEN
    RAISE EXCEPTION 'Unknown V3 legal entity scope';
  END IF;
  NEW.gl_scope := CASE WHEN entity_code='KTG-FR' THEN 'KONEKTAG_FRANCE_GL' ELSE 'KONEKTAG_CONGO_GL' END;
  NEW.legacy_classification := NULL;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Consumption proof compares the commercial principal independently from
-- Legal Entity. Existing historical rows with an entity remain valid.
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
  IF c.payment_rail IN ('qr','payment_link') THEN
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
   AND s.currency=c.currency;
 IF v_base IS NULL OR v_base<>c.merchant_value THEN RAISE EXCEPTION 'POINTS_MERCHANT_VALUE_MISMATCH'; END IF;
 RETURN NULL;
END; $$;

-- Bonus identity remains immutable; a NULL Legal Entity means accounting
-- attribution is pending/separate and must not invalidate the payment.
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
        OR NEW.legal_entity_id IS DISTINCT FROM c.legal_entity_id
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
      OR NEW.legal_entity_id IS DISTINCT FROM c.legal_entity_id
      OR NEW.amount<>c.merchant_value*0.01
    THEN RAISE EXCEPTION 'MERCHANT_BONUS_SOURCE_MISMATCH'; END IF;
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
