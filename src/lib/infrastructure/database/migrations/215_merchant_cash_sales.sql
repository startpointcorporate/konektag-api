BEGIN;
CREATE TABLE konektag.merchant_cash_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference VARCHAR(50) NOT NULL UNIQUE,
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  created_by UUID NOT NULL REFERENCES konektag.users(id),
  request_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency VARCHAR(3) NOT NULL,
  refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK(refunded_minor >= 0 AND refunded_minor <= amount_minor),
  status VARCHAR(20) NOT NULL DEFAULT 'RECORDED' CHECK(status IN ('RECORDED','PARTIALLY_REFUNDED','REFUNDED','CANCELLED')),
  description VARCHAR(1000),
  customer_encrypted BYTEA,
  has_email BOOLEAN NOT NULL DEFAULT false,
  merchant_snapshot JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(merchant_profile_id,request_key),
  CHECK ((status='RECORDED' AND refunded_minor=0) OR
    (status='PARTIALLY_REFUNDED' AND refunded_minor>0 AND refunded_minor<amount_minor) OR
    (status='REFUNDED' AND refunded_minor=amount_minor) OR (status='CANCELLED' AND refunded_minor=0))
);
CREATE INDEX merchant_cash_sales_history ON konektag.merchant_cash_sales(merchant_profile_id,created_at DESC,id DESC);
CREATE TABLE konektag.merchant_cash_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES konektag.merchant_cash_sales(id),
  actor_user_id UUID NOT NULL REFERENCES konektag.users(id),
  kind VARCHAR(10) NOT NULL CHECK(kind IN ('CANCEL','REFUND')),
  amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  reason VARCHAR(1000) NOT NULL CHECK(length(trim(reason))>0),
  request_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sale_id,request_key), UNIQUE(sale_id,to_version),
  CHECK(to_version=from_version+1)
);
CREATE TABLE konektag.merchant_cash_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES konektag.merchant_cash_sales(id),
  requested_by UUID NOT NULL REFERENCES konektag.users(id),
  request_key VARCHAR(128) NOT NULL,
  sale_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED','SUPERSEDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sale_id,request_key)
);
CREATE INDEX merchant_cash_receipt_history ON konektag.merchant_cash_receipts(sale_id,created_at DESC,id DESC);
CREATE FUNCTION konektag.guard_cash_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='merchant_cash_adjustments' THEN RAISE EXCEPTION 'CASH_HISTORY_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME='merchant_cash_receipts' THEN
    IF (to_jsonb(NEW)-'status'-'attempts'-'lease_until'-'sent_at'-'last_error') IS DISTINCT FROM
       (to_jsonb(OLD)-'status'-'attempts'-'lease_until'-'sent_at'-'last_error') THEN
      RAISE EXCEPTION 'CASH_RECEIPT_IDENTITY_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.reference,NEW.merchant_profile_id,NEW.created_by,NEW.request_key,NEW.request_hash,
    NEW.amount_minor,NEW.currency,NEW.description,NEW.customer_encrypted,NEW.has_email,NEW.merchant_snapshot,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.reference,OLD.merchant_profile_id,OLD.created_by,OLD.request_key,OLD.request_hash,
    OLD.amount_minor,OLD.currency,OLD.description,OLD.customer_encrypted,OLD.has_email,OLD.merchant_snapshot,OLD.created_at)
    THEN RAISE EXCEPTION 'CASH_SALE_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.version<>OLD.version+1 OR NOT EXISTS(
    SELECT 1 FROM konektag.merchant_cash_adjustments a WHERE a.sale_id=NEW.id
      AND a.from_version=OLD.version AND a.to_version=NEW.version AND
      ((a.kind='CANCEL' AND OLD.status='RECORDED' AND OLD.refunded_minor=0 AND NEW.status='CANCELLED'
        AND NEW.refunded_minor=0 AND a.amount_minor=OLD.amount_minor)
      OR (a.kind='REFUND' AND OLD.status IN ('RECORDED','PARTIALLY_REFUNDED')
        AND NEW.refunded_minor=OLD.refunded_minor+a.amount_minor AND NEW.status IN ('PARTIALLY_REFUNDED','REFUNDED')))
  ) THEN RAISE EXCEPTION 'CASH_CORRECTION_JOURNAL_REQUIRED'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cash_sales_identity BEFORE UPDATE OR DELETE ON konektag.merchant_cash_sales FOR EACH ROW EXECUTE FUNCTION konektag.guard_cash_history();
CREATE TRIGGER cash_adjustments_immutable BEFORE UPDATE OR DELETE ON konektag.merchant_cash_adjustments FOR EACH ROW EXECUTE FUNCTION konektag.guard_cash_history();
CREATE TRIGGER cash_receipts_identity BEFORE UPDATE OR DELETE ON konektag.merchant_cash_receipts FOR EACH ROW EXECUTE FUNCTION konektag.guard_cash_history();
COMMIT;
