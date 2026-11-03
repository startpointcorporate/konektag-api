-- 040_recharge_read_model.sql
-- Read model for backoffice recharge consultation (CQRS).
-- This table is the single source of truth for the Backoffice.
-- ERPNext is never queried directly by admin routes.

-- 1. Payment providers reference
CREATE TABLE IF NOT EXISTS konektag.payment_providers (
  code        VARCHAR(30) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('card', 'mobile_money', 'crypto')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO konektag.payment_providers (code, name, type) VALUES
  ('STRIPE',     'Stripe',              'card'),
  ('GOOGLE_PAY', 'Google Pay',          'card'),
  ('APPLE_PAY',  'Apple Pay',           'card'),
  ('MTN',        'MTN Mobile Money',    'mobile_money'),
  ('ORANGE',     'Orange Money',        'mobile_money'),
  ('AIRTEL',     'Airtel Money',        'mobile_money'),
  ('MOOV',       'Moov Money',          'mobile_money'),
  ('WAVE',       'Wave',                'mobile_money'),
  ('M_PESA',     'M-Pesa',              'mobile_money'),
  ('VODACOM',    'Vodacom M-Pesa',      'mobile_money'),
  ('USDT_ERC20', 'USDT (ERC-20)',       'crypto'),
  ('USDT_TRC20', 'USDT (TRC-20)',       'crypto'),
  ('USDT_BEP20', 'USDT (BEP-20)',       'crypto'),
  ('USDC_ERC20', 'USDC (ERC-20)',       'crypto'),
  ('USDC_TRC20', 'USDC (TRC-20)',       'crypto'),
  ('BTC',        'Bitcoin',             'crypto'),
  ('ETH',        'Ethereum',            'crypto')
ON CONFLICT (code) DO NOTHING;

-- 2. Recharge read model (backoffice source of truth)
DO $$ BEGIN
  CREATE TYPE konektag.recharge_workflow_state AS ENUM (
    'pending',
    'waiting_payment',
    'provider_received',
    'waiting_validation',
    'confirmed',
    'reversed',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE konektag.payment_method_type AS ENUM ('card', 'mobile_money', 'crypto');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS konektag.recharge_read_model (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to external systems
  recharge_name         VARCHAR(100) NOT NULL UNIQUE,          -- ERPNext doc name (KTG-RECH-XXXXX)
  keycloak_id           UUID NOT NULL,
  user_id               UUID REFERENCES konektag.users(id),

  -- Amounts
  requested_amount      BIGINT NOT NULL,
  requested_currency    VARCHAR(10) NOT NULL DEFAULT 'XOF',
  credited_amount       BIGINT,
  credited_currency     VARCHAR(10) DEFAULT 'XOF',

  -- Payment method & provider
  payment_method        konektag.payment_method_type NOT NULL,
  payment_provider      VARCHAR(30) REFERENCES konektag.payment_providers(code),

  -- Workflow
  workflow_state        konektag.recharge_workflow_state NOT NULL DEFAULT 'pending',

  -- Provider metadata (flexible JSONB for any payment gateway)
  provider_reference    VARCHAR(255),                           -- Stripe PI, MM ref, crypto tx hash
  provider_status       VARCHAR(50),                            -- Raw status from provider
  provider_payload      JSONB,                                  -- Full provider response
  provider_fees         BIGINT,                                 -- Fees in smallest unit
  provider_message      TEXT,                                   -- Human-readable message

  -- Method-specific fields (denormalized for fast filtering)
  stripe_payment_intent VARCHAR(255),
  mobile_money_operator VARCHAR(30),
  mobile_money_phone    VARCHAR(30),
  crypto_network        VARCHAR(30),
  crypto_address        VARCHAR(255),

  -- Internal reference
  internal_reference    VARCHAR(100),

  -- Geography
  country               VARCHAR(5),

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  reversed_at           TIMESTAMPTZ,

  -- Anomaly flag (computed at write time)
  anomaly               VARCHAR(100),

  -- Soft delete
  deleted_at            TIMESTAMPTZ
);

-- Indexes for admin queries
CREATE INDEX IF NOT EXISTS idx_rrm_workflow_state   ON konektag.recharge_read_model(workflow_state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_payment_method   ON konektag.recharge_read_model(payment_method) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_payment_provider ON konektag.recharge_read_model(payment_provider) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_currency         ON konektag.recharge_read_model(requested_currency) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_country          ON konektag.recharge_read_model(country) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_created_at       ON konektag.recharge_read_model(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_keycloak_id      ON konektag.recharge_read_model(keycloak_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_anomaly          ON konektag.recharge_read_model(anomaly) WHERE anomaly IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_credited         ON konektag.recharge_read_model(credited_amount) WHERE credited_amount IS NULL AND deleted_at IS NULL;
-- Full-text search index requires pg_trgm extension; uncomment if extension is enabled:
-- CREATE INDEX IF NOT EXISTS idx_rrm_search ON konektag.recharge_read_model USING gin (internal_reference gin_trgm_ops, recharge_name gin_trgm_ops);
-- For now, search relies on ILIKE with b-tree indexes below:
CREATE INDEX IF NOT EXISTS idx_rrm_ref             ON konektag.recharge_read_model(internal_reference) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_name            ON konektag.recharge_read_model(recharge_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rrm_user_email       ON konektag.recharge_read_model(keycloak_id, created_at DESC) WHERE deleted_at IS NULL;

-- 3. Recharge events (status transition history)
CREATE TABLE IF NOT EXISTS konektag.recharge_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recharge_id   UUID NOT NULL REFERENCES konektag.recharge_read_model(id),
  from_state    konektag.recharge_workflow_state,
  to_state      konektag.recharge_workflow_state NOT NULL,
  changed_by    UUID REFERENCES konektag.users(id),
  reason        TEXT,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_re_charge    ON konektag.recharge_events(recharge_id);
CREATE INDEX IF NOT EXISTS idx_re_created   ON konektag.recharge_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_re_to_state  ON konektag.recharge_events(to_state);

-- 4. Admin actions (all administrative operations)
CREATE TABLE IF NOT EXISTS konektag.admin_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES konektag.users(id),
  action_type   VARCHAR(50) NOT NULL,           -- 'RECHARGE_CONFIRM', 'RECHARGE_REVERSE', etc.
  target_type   VARCHAR(30) NOT NULL,           -- 'recharge', 'user', 'merchant'
  target_id     VARCHAR(100) NOT NULL,          -- UUID or external ID
  reason        TEXT NOT NULL,                  -- Mandatory reason for all admin actions
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aa_admin     ON konektag.admin_actions(admin_id);
CREATE INDEX IF NOT EXISTS idx_aa_target    ON konektag.admin_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_aa_type      ON konektag.admin_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_aa_created   ON konektag.admin_actions(created_at DESC);
