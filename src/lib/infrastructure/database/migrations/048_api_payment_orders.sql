-- Source of truth for API-created checkout orders. Checkout tokens are stored
-- only as SHA-256 hashes so a database read cannot be used to pay an order.
CREATE TABLE IF NOT EXISTS konektag.api_payment_orders (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id        UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  environment                VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox', 'live')),
  merchant_transaction_id    VARCHAR(255) NOT NULL,
  label                      VARCHAR(500) NOT NULL,
  payer_identity             VARCHAR(500) NOT NULL,
  currency                   VARCHAR(3) NOT NULL,
  subtotal_amount            INTEGER NOT NULL CHECK (subtotal_amount >= 0),
  tax_amount                 INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  fee_amount                 INTEGER NOT NULL CHECK (fee_amount >= 0),
  cashback_amount            INTEGER NOT NULL DEFAULT 0 CHECK (cashback_amount >= 0),
  total_amount               INTEGER NOT NULL CHECK (total_amount >= 0),
  checkout_token_hash        VARCHAR(64) NOT NULL,
  state                      VARCHAR(30) NOT NULL DEFAULT 'pending'
                             CHECK (state IN ('pending', 'processing', 'awaiting_mobile_money', 'paid', 'failed', 'expired')),
  payment_method             VARCHAR(30) CHECK (payment_method IS NULL OR payment_method IN ('sandbox', 'wallet', 'card', 'mobile_money')),
  stripe_payment_intent_id   VARCHAR(255),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                    TIMESTAMPTZ,
  version                    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (merchant_profile_id, merchant_transaction_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_payment_orders_token_hash
  ON konektag.api_payment_orders(checkout_token_hash);

CREATE INDEX IF NOT EXISTS idx_api_payment_orders_merchant_state
  ON konektag.api_payment_orders(merchant_profile_id, state, created_at DESC);
