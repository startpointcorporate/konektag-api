BEGIN;

CREATE TABLE konektag.wallet_integrity_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), party_id uuid NOT NULL REFERENCES konektag.parties(id),
 rule_code text NOT NULL, severity text NOT NULL CHECK(severity IN ('WARNING','CRITICAL')),
 observed_balance numeric NOT NULL, expected_balance numeric NOT NULL, difference numeric NOT NULL,
 fingerprint text NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','FALSE_POSITIVE','RESOLVED')),
 detected_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 acknowledged_at timestamptz, acknowledged_by uuid REFERENCES konektag.users(id),
 resolved_at timestamptz, resolved_by uuid REFERENCES konektag.users(id), resolution_reason text,
 details jsonb NOT NULL, UNIQUE(party_id,rule_code,fingerprint)
);
CREATE INDEX k_wallet_source_lookup ON konektag.k_wallet_entries(source_type,source_id);
CREATE INDEX wallet_integrity_open ON konektag.wallet_integrity_alerts(status,detected_at DESC);
CREATE TABLE konektag.financial_account_controls (
 party_id uuid PRIMARY KEY REFERENCES konektag.parties(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVIEW','BLOCKED')),
 source_alert_id uuid REFERENCES konektag.wallet_integrity_alerts(id),
 blocked_at timestamptz, blocked_by uuid REFERENCES konektag.users(id),
 released_at timestamptz, released_by uuid REFERENCES konektag.users(id), release_reason text,
 suppression_until timestamptz, version integer NOT NULL DEFAULT 1
);
CREATE TABLE konektag.financial_account_control_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), party_id uuid NOT NULL REFERENCES konektag.parties(id),
 alert_id uuid REFERENCES konektag.wallet_integrity_alerts(id), actor_id uuid REFERENCES konektag.users(id),
 action text NOT NULL, reason text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX financial_control_events_party ON konektag.financial_account_control_events(party_id,created_at);

CREATE FUNCTION konektag.reject_financial_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'FINANCIAL_CONTROL_AUDIT_IMMUTABLE'; END $$;
CREATE TRIGGER financial_control_audit_immutable BEFORE UPDATE OR DELETE ON konektag.financial_account_control_events
 FOR EACH ROW EXECUTE FUNCTION konektag.reject_financial_audit_mutation();

-- Repair the obsolete balance function, preserving its public signature.
CREATE OR REPLACE FUNCTION konektag.points_balance(p_owner uuid)
RETURNS TABLE(balance numeric,reserved numeric,available numeric)
LANGUAGE SQL STABLE SET search_path=pg_catalog AS $$
 SELECT b.n,r.n,b.n-r.n FROM
 (SELECT konektag.k_wallet_balance(p_owner)::numeric n) b CROSS JOIN
 (SELECT COALESCE(sum(amount),0)::numeric n FROM konektag.api_payment_wallet_reservations
  WHERE payer_party_id=p_owner AND currency='K' AND lifecycle='active' AND expires_at>statement_timestamp()) r;
$$;

CREATE FUNCTION konektag.require_financial_account_active(p_party uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('points-wallet:'||p_party::text,0));
 SELECT * INTO c FROM konektag.financial_account_controls WHERE party_id=p_party;
 IF c.status IN ('REVIEW','BLOCKED') THEN
  RAISE EXCEPTION 'ACCOUNT_FINANCIAL_REVIEW' USING ERRCODE='P0001',DETAIL=COALESCE(c.source_alert_id::text,p_party::text);
 END IF;
END $$;

-- Defence in depth for direct writers, including old financial services.
CREATE FUNCTION konektag.financial_debit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='k_wallet_entries' THEN
  IF NEW.direction='debit' THEN PERFORM konektag.require_financial_account_active(NEW.party_id); END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  IF NEW.entry_side='debit' AND NEW.party_id IS NOT NULL AND NEW.account_code='1000' THEN
   PERFORM konektag.require_financial_account_active(NEW.party_id);
  END IF;
 ELSE
  IF NEW.lifecycle='active' OR (TG_OP='UPDATE' AND NEW.lifecycle='captured' AND OLD.lifecycle IS DISTINCT FROM NEW.lifecycle) THEN
   PERFORM konektag.require_financial_account_active(NEW.payer_party_id);
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_financial_guard BEFORE INSERT ON konektag.k_wallet_entries FOR EACH ROW EXECUTE FUNCTION konektag.financial_debit_guard();
CREATE TRIGGER ledger_financial_guard BEFORE INSERT ON konektag.ledger_entries FOR EACH ROW EXECUTE FUNCTION konektag.financial_debit_guard();
CREATE TRIGGER reservation_financial_guard BEFORE INSERT OR UPDATE ON konektag.api_payment_wallet_reservations FOR EACH ROW EXECUTE FUNCTION konektag.financial_debit_guard();

-- Project future effective ledger entries on finalization, including transactions
-- inserted completed and reversals. No historical backfill or balance repair.
CREATE FUNCTION konektag.project_k_wallet_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tx uuid; e record;
BEGIN
 IF TG_TABLE_NAME='ledger_entries' THEN tx:=NEW.transaction_id;
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
CREATE CONSTRAINT TRIGGER project_k_wallet_entry AFTER INSERT ON konektag.ledger_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION konektag.project_k_wallet_ledger();
CREATE TRIGGER project_k_wallet_transaction AFTER INSERT OR UPDATE ON konektag.financial_transactions
 FOR EACH ROW EXECUTE FUNCTION konektag.project_k_wallet_ledger();

COMMIT;
