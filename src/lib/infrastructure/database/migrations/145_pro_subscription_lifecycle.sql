BEGIN;

ALTER TABLE konektag.merchant_pro_subscriptions
  ADD COLUMN IF NOT EXISTS price_minor INTEGER,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS activated_by UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_order_id UUID REFERENCES konektag.api_payment_orders(id),
  ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ;

-- Historical overlapping rows remain untouched. New audited activations are
-- unique; the service also locks the commerce and checks legacy ACTIVE rows.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_pro_one_new_active
  ON konektag.merchant_pro_subscriptions(merchant_profile_id)
  WHERE status = 'ACTIVE' AND activated_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS konektag.merchant_pro_renewal_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  subscription_id UUID NOT NULL REFERENCES konektag.merchant_pro_subscriptions(id),
  payment_order_id UUID UNIQUE REFERENCES konektag.api_payment_orders(id),
  request_key VARCHAR(100) NOT NULL,
  subscription_type VARCHAR(10) NOT NULL CHECK (subscription_type IN ('MONTHLY','ANNUAL')),
  price_minor INTEGER CHECK (price_minor > 0),
  currency VARCHAR(3),
  payment_country VARCHAR(5),
  exchange_rate_id UUID REFERENCES konektag.exchange_rates(id),
  exchange_rate NUMERIC(21,9),
  exchange_rate_inverse BOOLEAN NOT NULL DEFAULT false,
  exchange_rate_source VARCHAR(100),
  exchange_rate_timestamp TIMESTAMPTZ,
  checkout_attempts INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  UNIQUE (merchant_profile_id, request_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_pro_one_pending_renewal
  ON konektag.merchant_pro_renewal_intents(subscription_id) WHERE status = 'PENDING';

ALTER TABLE konektag.pro_inquiries
  ADD COLUMN IF NOT EXISTS merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id);

COMMIT;
