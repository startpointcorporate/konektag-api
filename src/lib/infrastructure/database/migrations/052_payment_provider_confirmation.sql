-- Unified provider confirmation records. Provider payloads and cardholder data
-- are deliberately excluded; only an event hash and explicitly safe attributes persist.
CREATE TABLE IF NOT EXISTS konektag.payment_provider_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type           VARCHAR(30) NOT NULL CHECK (source_type IN (
                          'recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link'
                        )),
  source_id             VARCHAR(255) NOT NULL CHECK (length(trim(source_id)) > 0),
  operation_id          VARCHAR(255) NOT NULL CHECK (length(trim(operation_id)) > 0),
  provider              VARCHAR(50) NOT NULL,
  provider_reference    VARCHAR(255) NOT NULL,
  expected_amount       BIGINT NOT NULL CHECK (expected_amount > 0),
  expected_currency     VARCHAR(3) NOT NULL CHECK (expected_currency = upper(expected_currency)),
  provider_country      VARCHAR(2),
  provider_card_brand   VARCHAR(50),
  provider_card_funding VARCHAR(30),
  provider_card_bin     VARCHAR(8),
  state                 VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN (
                          'pending', 'processing', 'succeeded', 'failed', 'cancelled'
                        )),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  version               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (provider, provider_reference),
  CHECK (provider_card_bin IS NULL OR provider_card_bin ~ '^[0-9]{8}$'),
  CHECK (NOT (metadata ?| ARRAY['pan', 'cvc', 'expiry', 'last4', 'client_secret', 'raw_payload', 'stripe_payload']))
);

CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_source
  ON konektag.payment_provider_attempts(source_type, source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS konektag.payment_provider_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          VARCHAR(50) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  attempt_id        UUID REFERENCES konektag.payment_provider_attempts(id),
  event_type        VARCHAR(100) NOT NULL,
  payload_hash      CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  error_code        VARCHAR(100),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_provider_events_attempt
  ON konektag.payment_provider_events(attempt_id, received_at DESC);
