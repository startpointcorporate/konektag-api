-- Merchant-owned webhook configuration and delivery history for API payments.
CREATE TABLE IF NOT EXISTS konektag.merchant_api_webhook_endpoints (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  environment         VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox', 'live')),
  webhook_url         TEXT,
  signing_secret      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_profile_id, environment)
);

CREATE TABLE IF NOT EXISTS konektag.api_payment_webhook_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id         UUID NOT NULL REFERENCES konektag.merchant_api_webhook_endpoints(id),
  payment_order_id    UUID NOT NULL REFERENCES konektag.api_payment_orders(id),
  event_key           VARCHAR(500) NOT NULL,
  event_type          VARCHAR(100) NOT NULL,
  payload             JSONB NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  response_status     INTEGER,
  response_body       TEXT,
  last_error          TEXT,
  attempted_at        TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS idx_api_payment_webhook_deliveries_retry
  ON konektag.api_payment_webhook_deliveries(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
