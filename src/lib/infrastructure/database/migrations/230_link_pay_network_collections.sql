-- Migration 230: Link Pay collected for a beneficiary Frappe site on behalf of its network (Réseau) site.
-- Additive and idempotent. Existing payment links (merchant profile, personal, catalogue, BOOST) keep
-- their rows, constraints and behaviour: a row is a network link only when collection_route is set.
-- The new route never references konektag.merchant_profiles: the beneficiary is a Frappe site, its
-- collection terms are read from the network site and frozen here at issuance.

-- 1. A network link has neither a merchant profile nor an owner user.
ALTER TABLE konektag.checkout_intents
  ADD COLUMN IF NOT EXISTS collection_route TEXT;

ALTER TABLE konektag.checkout_intents
  DROP CONSTRAINT IF EXISTS checkout_intents_collection_route_check;
ALTER TABLE konektag.checkout_intents
  ADD CONSTRAINT checkout_intents_collection_route_check
    CHECK (collection_route IS NULL OR (collection_route = 'frappe_network' AND source_type = 'payment_link'));

ALTER TABLE konektag.checkout_intents
  DROP CONSTRAINT IF EXISTS checkout_intents_owner_check;
ALTER TABLE konektag.checkout_intents
  ADD CONSTRAINT checkout_intents_owner_check
    CHECK (((merchant_profile_id IS NOT NULL) <> (owner_user_id IS NOT NULL))
        OR (collection_route = 'frappe_network' AND merchant_profile_id IS NULL AND owner_user_id IS NULL));

-- 2. Origin and frozen collection terms of each network link.
CREATE TABLE IF NOT EXISTS konektag.link_pay_network_links (
  checkout_intent_id   UUID PRIMARY KEY REFERENCES konektag.checkout_intents(id),
  -- frappe-site:<issuer site>:<attempt key>; one link per Frappe attempt.
  origin_key           TEXT NOT NULL UNIQUE CHECK (origin_key ~ '^frappe-site:[A-Z][A-Z0-9_]{1,31}:[a-f0-9]{64}$'),
  issuer_site          TEXT NOT NULL CHECK (issuer_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  beneficiary_site     TEXT NOT NULL CHECK (beneficiary_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  network_site         TEXT NOT NULL CHECK (network_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  invoice              TEXT NOT NULL CHECK (length(invoice) BETWEEN 1 AND 140),
  invoice_company      TEXT NOT NULL,
  beneficiary_name     TEXT NOT NULL CHECK (length(beneficiary_name) BETWEEN 1 AND 140),
  country              CHAR(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency             VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fee_mode             TEXT NOT NULL CHECK (fee_mode IN ('PERCENTAGE', 'EXEMPT')),
  fee_rate_bps         INTEGER NOT NULL CHECK (fee_rate_bps BETWEEN 0 AND 10000),
  approved_by          TEXT NOT NULL CHECK (length(approved_by) > 0),
  approved_at          TIMESTAMPTZ NOT NULL,
  terms_hash           TEXT NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The invoice lives on the issuing site and is settled there: issuer and beneficiary are one site.
  CONSTRAINT link_pay_network_links_issuer_is_beneficiary CHECK (issuer_site = beneficiary_site),
  CONSTRAINT link_pay_network_links_fee_rule CHECK (
    (fee_mode = 'EXEMPT' AND fee_rate_bps = 0) OR (fee_mode = 'PERCENTAGE' AND fee_rate_bps > 0))
);
CREATE INDEX IF NOT EXISTS idx_link_pay_network_links_invoice
  ON konektag.link_pay_network_links(issuer_site, invoice);

-- 3. One transaction per paid network link: gross = fee + net, in minor units of the link currency.
CREATE TABLE IF NOT EXISTS konektag.link_pay_network_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_intent_id   UUID NOT NULL UNIQUE REFERENCES konektag.link_pay_network_links(checkout_intent_id),
  k_operation_id       UUID NOT NULL UNIQUE REFERENCES konektag.k_operations(id),
  payer_user_id        UUID NOT NULL REFERENCES konektag.users(id),
  beneficiary_site     TEXT NOT NULL,
  network_site         TEXT NOT NULL,
  invoice              TEXT NOT NULL,
  currency             VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor          BIGINT NOT NULL CHECK (gross_minor > 0),
  fee_minor            BIGINT NOT NULL CHECK (fee_minor >= 0),
  net_minor            BIGINT NOT NULL CHECK (net_minor >= 0),
  quantity_k           BIGINT NOT NULL CHECK (quantity_k > 0),
  -- Collected for a third party (owed to the beneficiary) versus for the network itself.
  third_party          BOOLEAN GENERATED ALWAYS AS (beneficiary_site <> network_site) STORED,
  paid_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT link_pay_network_transactions_split CHECK (gross_minor = fee_minor + net_minor)
);

-- 4. Signed webhooks to Frappe sites, network first. A beneficiary delivery stays 'blocked' until the
-- network delivery it depends on is acknowledged; a single delivery carries both roles for one site.
CREATE TABLE IF NOT EXISTS konektag.link_pay_site_webhooks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        UUID NOT NULL REFERENCES konektag.link_pay_network_transactions(id),
  target_site           TEXT NOT NULL CHECK (target_site ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  roles                 TEXT[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 2 AND roles <@ ARRAY['network', 'beneficiary']::text[]),
  depends_on            UUID REFERENCES konektag.link_pay_site_webhooks(id),
  event_key             TEXT NOT NULL UNIQUE,
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('blocked', 'pending', 'processing', 'delivered', 'failed', 'dead_lettered')),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  response_status       INTEGER,
  response_body         TEXT,
  last_error            TEXT,
  attempted_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  next_attempt_at       TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  processing_lease_id   UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT link_pay_site_webhooks_one_per_site UNIQUE (transaction_id, target_site),
  CONSTRAINT link_pay_site_webhooks_blocked_has_parent CHECK (status <> 'blocked' OR depends_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_link_pay_site_webhooks_due
  ON konektag.link_pay_site_webhooks(status, next_attempt_at, processing_started_at)
  WHERE status IN ('pending', 'failed', 'processing');
CREATE INDEX IF NOT EXISTS idx_link_pay_site_webhooks_parent
  ON konektag.link_pay_site_webhooks(depends_on) WHERE depends_on IS NOT NULL;

-- 5. Payment facts are append-only: a replay can never rewrite a recorded split.
CREATE OR REPLACE FUNCTION konektag.link_pay_network_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS link_pay_network_links_immutable ON konektag.link_pay_network_links;
CREATE TRIGGER link_pay_network_links_immutable BEFORE UPDATE OR DELETE ON konektag.link_pay_network_links
  FOR EACH ROW EXECUTE FUNCTION konektag.link_pay_network_immutable();
DROP TRIGGER IF EXISTS link_pay_network_transactions_immutable ON konektag.link_pay_network_transactions;
CREATE TRIGGER link_pay_network_transactions_immutable BEFORE UPDATE OR DELETE ON konektag.link_pay_network_transactions
  FOR EACH ROW EXECUTE FUNCTION konektag.link_pay_network_immutable();

-- 6. A consumed link must prove its Points K extinction. Merchant-profile links keep the proof of
-- migration 200 unchanged; a network link proves it with its network transaction instead.
CREATE OR REPLACE FUNCTION konektag.check_link_k_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF NEW.k_operation_id IS NOT NULL AND NEW.collection_route = 'frappe_network' THEN
  IF NOT EXISTS(
   SELECT 1 FROM konektag.k_operations k JOIN konektag.link_pay_network_transactions t ON t.k_operation_id=k.id
    JOIN konektag.parties p ON p.id=k.party_id JOIN konektag.users u ON u.keycloak_id=p.keycloak_id
   WHERE k.id=NEW.k_operation_id AND k.status='completed' AND k.operation_type='merchant_consumption'
    AND t.checkout_intent_id=NEW.id AND t.gross_minor=NEW.amount AND t.currency=NEW.currency
    AND t.quantity_k=NEW.quantity_k AND k.quantity=NEW.quantity_k AND u.id=NEW.payer_user_id
    AND t.payer_user_id=NEW.payer_user_id)
  THEN RAISE EXCEPTION 'LINK_K_COMPLETION_PROOF_REQUIRED'; END IF;
  RETURN NULL;
 END IF;
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
END $function$;
