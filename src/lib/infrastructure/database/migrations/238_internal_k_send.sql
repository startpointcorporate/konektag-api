-- Internal Points K transfers use the existing K ledger, never ERPNext regulatory profiles.
BEGIN;
ALTER TABLE konektag.k_operations ADD COLUMN recipient_party_id uuid REFERENCES konektag.parties(id),
 DROP CONSTRAINT k_operations_operation_type_check, DROP CONSTRAINT k_operations_check1,
 ADD CONSTRAINT k_operations_operation_type_check CHECK(operation_type IN ('merchant_consumption','refund','k_send')),
 ADD CONSTRAINT k_operations_shape CHECK(
  (operation_type='merchant_consumption' AND reservation_id IS NOT NULL AND source_operation_id IS NULL AND recipient_party_id IS NULL)
  OR (operation_type='refund' AND reservation_id IS NULL AND source_operation_id IS NOT NULL AND recipient_party_id IS NULL)
  OR (operation_type='k_send' AND reservation_id IS NULL AND source_operation_id IS NULL AND recipient_party_id IS NOT NULL AND recipient_party_id<>party_id));
CREATE OR REPLACE FUNCTION konektag.guard_k_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
 IF NEW.status='completed' AND NEW.operation_type='k_send' THEN
  SELECT count(*)=2 AND count(*) FILTER(WHERE e.entry_side='debit')=1
   AND count(*) FILTER(WHERE e.entry_side='credit')=1
   AND bool_and(e.account_code='1000' AND e.currency='K' AND e.amount=NEW.quantity AND e.gl_scope='GLOBAL_USER_GL'
    AND ((e.entry_side='debit' AND e.party_id=NEW.party_id)
      OR (e.entry_side='credit' AND e.party_id=NEW.recipient_party_id)))
   INTO valid FROM konektag.ledger_entries e WHERE e.k_operation_id=NEW.id;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'K_OPERATION_LEDGER_PROOF_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM konektag.parties WHERE id=NEW.recipient_party_id AND is_active)
    OR NOT EXISTS(SELECT 1 FROM konektag.parties WHERE id=NEW.party_id AND is_active)
  THEN RAISE EXCEPTION 'POINTS_OWNER_UNAVAILABLE'; END IF;
  SELECT * INTO b FROM konektag.points_balance(NEW.party_id);
  IF b.available<NEW.quantity THEN RAISE EXCEPTION 'K_SEND_INSUFFICIENT'; END IF;
  RETURN NEW;
 END IF;
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
CREATE OR REPLACE FUNCTION konektag.project_k_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='completed' AND OLD.status='pending' THEN
  INSERT INTO konektag.k_wallet_entries(party_id,operation_id,operation_type,direction,quantity_k,counterparty_party_id,source_type,source_id,created_at)
   SELECT e.party_id,NEW.id,CASE WHEN NEW.operation_type IN ('refund','k_send') THEN NEW.operation_type ELSE 'payment' END,
    e.entry_side,e.amount::bigint,CASE WHEN NEW.operation_type='k_send' THEN
     CASE WHEN e.party_id=NEW.party_id THEN NEW.recipient_party_id ELSE NEW.party_id END END,'k_operation_ledger',e.id::text,e.created_at
   FROM konektag.ledger_entries e WHERE e.k_operation_id=NEW.id AND e.account_code='1000';
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION konektag.check_k_operation_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE k konektag.k_operations%ROWTYPE;
BEGIN
 SELECT * INTO k FROM konektag.k_operations WHERE id=NEW.id;
 IF k.status<>'completed' THEN RAISE EXCEPTION 'K_OPERATION_INCOMPLETE'; END IF;
 IF k.operation_type='k_send' THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.k_send_intents i
   JOIN konektag.users sender ON sender.id=i.sender_user_id
   JOIN konektag.users recipient ON recipient.id=i.recipient_user_id
   JOIN konektag.parties sp ON sp.keycloak_id=sender.keycloak_id
   JOIN konektag.parties rp ON rp.keycloak_id=recipient.keycloak_id
   WHERE i.operation_id=k.id AND i.status='Funded' AND i.quantity_k=k.quantity
    AND sp.id=k.party_id AND rp.id=k.recipient_party_id
    AND k.operation_key='k_send:'||i.id::text AND length(trim(i.funding_reference))>0)
  THEN RAISE EXCEPTION 'K_SEND_INTENT_PROOF_REQUIRED'; END IF;
 ELSIF k.operation_type='merchant_consumption' THEN
  IF NOT EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations r WHERE r.id=k.reservation_id
    AND r.k_operation_id=k.id AND r.lifecycle='captured') THEN RAISE EXCEPTION 'K_CAPTURE_REQUIRED'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM konektag.points_merchant_refunds r JOIN konektag.points_merchant_consumptions c ON c.id=r.consumption_id
   WHERE r.k_operation_id=k.id AND r.quantity=k.quantity AND c.k_operation_id=k.source_operation_id)
  THEN RAISE EXCEPTION 'K_REFUND_PROOF_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION konektag.guard_k_wallet_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
   AND NEW.operation_type=CASE WHEN k.operation_type IN ('refund','k_send') THEN k.operation_type ELSE 'payment' END
   AND NEW.counterparty_party_id IS NOT DISTINCT FROM CASE WHEN k.operation_type='k_send' THEN
     CASE WHEN e.party_id=k.party_id THEN k.recipient_party_id ELSE k.party_id END END)
 THEN RAISE EXCEPTION 'K_WALLET_PROOF_REQUIRED'; END IF;
 RETURN NEW;
END $$;
COMMIT;
