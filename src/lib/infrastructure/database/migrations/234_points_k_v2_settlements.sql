-- Points K V2, flux 3: processing journal of a confirmed Points K purchase.
-- ERPNext stays the accounting system (Sales Invoice, Payment Entry, Payment Request
-- status). This table only records which ERPNext documents settled which verified
-- provider payment, and which K ledger transaction credited the buyer, so that every
-- step can be resumed without being written twice. It holds no amount of its own
-- besides the verified provider proof and the K quantity read from the Quotation.
BEGIN;

CREATE TABLE konektag.points_k_settlements (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 UUID NOT NULL UNIQUE REFERENCES konektag.api_payment_orders(id),
  site                     VARCHAR(32) NOT NULL CHECK (site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  customer                 TEXT NOT NULL CHECK (length(trim(customer)) > 0),
  quotation                TEXT NOT NULL CHECK (length(trim(quotation)) > 0),
  sales_order              TEXT NOT NULL CHECK (length(trim(sales_order)) > 0),
  payment_request          TEXT NOT NULL CHECK (length(trim(payment_request)) > 0),
  item_code                TEXT NOT NULL CHECK (length(trim(item_code)) > 0),
  handler                  VARCHAR(30) NOT NULL CHECK (handler IN ('points_k')),
  currency                 VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Verified provider proof (minor units of currency): never a number of K.
  confirmed_minor          BIGINT NOT NULL CHECK (confirmed_minor > 0),
  provider                 VARCHAR(20) NOT NULL CHECK (provider IN ('stripe', 'pawapay')),
  provider_reference       TEXT NOT NULL,
  attempt_id               UUID NOT NULL UNIQUE REFERENCES konektag.payment_provider_attempts(id),
  event_id                 UUID NOT NULL REFERENCES konektag.payment_provider_events(id),
  -- Read from the Quotation item once ERPNext documents are verified.
  quantity_k               BIGINT CHECK (quantity_k > 0),
  net_minor                BIGINT CHECK (net_minor > 0),
  status                   VARCHAR(30) NOT NULL DEFAULT 'payment_confirmed' CHECK (status IN (
                             'payment_confirmed', 'invoice_submitted', 'payment_entry_submitted', 'k_credited')),
  sales_invoice            TEXT,
  payment_entry            TEXT,
  payment_request_status   TEXT,
  financial_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  last_error               TEXT,
  lease_token              UUID,
  lease_until              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  UNIQUE (site, payment_request),
  UNIQUE (site, sales_order),
  UNIQUE (provider, provider_reference),
  CHECK (status = 'payment_confirmed' OR (sales_invoice IS NOT NULL AND quantity_k IS NOT NULL AND net_minor IS NOT NULL)),
  CHECK (status IN ('payment_confirmed', 'invoice_submitted') OR payment_entry IS NOT NULL),
  CHECK (status <> 'k_credited' OR (financial_transaction_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX idx_points_k_settlements_pending
  ON konektag.points_k_settlements(updated_at) WHERE status <> 'k_credited';

-- Append-only evidence of each processing step (no provider payload, no card data).
CREATE TABLE konektag.points_k_settlement_steps (
  id            BIGSERIAL PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES konektag.points_k_settlements(id),
  step          VARCHAR(40) NOT NULL,
  outcome       VARCHAR(20) NOT NULL CHECK (outcome IN ('done', 'reused', 'pending', 'failed')),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_points_k_settlement_steps ON konektag.points_k_settlement_steps(settlement_id, id);

CREATE FUNCTION konektag.points_k_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rank_old INTEGER; rank_new INTEGER;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'POINTS_K_SETTLEMENT_IMMUTABLE'; END IF;
 IF NEW.order_id <> OLD.order_id OR NEW.site <> OLD.site OR NEW.customer <> OLD.customer
   OR NEW.quotation <> OLD.quotation OR NEW.sales_order <> OLD.sales_order
   OR NEW.payment_request <> OLD.payment_request OR NEW.item_code <> OLD.item_code
   OR NEW.handler <> OLD.handler OR NEW.currency <> OLD.currency
   OR NEW.confirmed_minor <> OLD.confirmed_minor OR NEW.provider <> OLD.provider
   OR NEW.provider_reference <> OLD.provider_reference OR NEW.attempt_id <> OLD.attempt_id
   OR NEW.event_id <> OLD.event_id THEN
   RAISE EXCEPTION 'POINTS_K_SETTLEMENT_IDENTITY_IMMUTABLE';
 END IF;
 -- Once recorded, an ERPNext document or a K quantity is never replaced.
 IF (OLD.quantity_k IS NOT NULL AND NEW.quantity_k IS DISTINCT FROM OLD.quantity_k)
   OR (OLD.net_minor IS NOT NULL AND NEW.net_minor IS DISTINCT FROM OLD.net_minor)
   OR (OLD.sales_invoice IS NOT NULL AND NEW.sales_invoice IS DISTINCT FROM OLD.sales_invoice)
   OR (OLD.payment_entry IS NOT NULL AND NEW.payment_entry IS DISTINCT FROM OLD.payment_entry)
   OR (OLD.financial_transaction_id IS NOT NULL AND NEW.financial_transaction_id IS DISTINCT FROM OLD.financial_transaction_id) THEN
   RAISE EXCEPTION 'POINTS_K_SETTLEMENT_DOCUMENT_IMMUTABLE';
 END IF;
 rank_old := array_position(ARRAY['payment_confirmed','invoice_submitted','payment_entry_submitted','k_credited'], OLD.status::text);
 rank_new := array_position(ARRAY['payment_confirmed','invoice_submitted','payment_entry_submitted','k_credited'], NEW.status::text);
 IF rank_new < rank_old THEN RAISE EXCEPTION 'POINTS_K_SETTLEMENT_STATUS_REGRESSION'; END IF;
 IF OLD.status = 'k_credited' AND (to_jsonb(NEW) - ARRAY['lease_token','lease_until','updated_at','attempt_count','last_error','payment_request_status'])
   IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['lease_token','lease_until','updated_at','attempt_count','last_error','payment_request_status']) THEN
   RAISE EXCEPTION 'POINTS_K_SETTLEMENT_COMPLETED';
 END IF;
 IF NEW.status = 'k_credited' AND NOT EXISTS (
   SELECT 1 FROM konektag.points_acquisitions a
   WHERE a.order_id = NEW.order_id AND a.transaction_id = NEW.financial_transaction_id AND a.quantity = NEW.quantity_k) THEN
   RAISE EXCEPTION 'POINTS_K_SETTLEMENT_CREDIT_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_k_settlement_guard BEFORE UPDATE OR DELETE ON konektag.points_k_settlements
 FOR EACH ROW EXECUTE FUNCTION konektag.points_k_settlement_guard();

CREATE FUNCTION konektag.points_k_settlement_steps_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POINTS_K_SETTLEMENT_STEPS_APPEND_ONLY'; END $$;
CREATE TRIGGER points_k_settlement_steps_append_only BEFORE UPDATE OR DELETE ON konektag.points_k_settlement_steps
 FOR EACH ROW EXECUTE FUNCTION konektag.points_k_settlement_steps_append_only();

COMMIT;
