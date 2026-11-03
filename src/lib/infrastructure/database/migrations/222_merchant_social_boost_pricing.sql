BEGIN;

CREATE TABLE IF NOT EXISTS konektag.merchant_social_boost_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  target_country CHAR(2) NOT NULL,
  target_country_name TEXT NOT NULL,
  erpnext_item_code TEXT NOT NULL,
  price_list TEXT NOT NULL DEFAULT 'Standard Selling',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES konektag.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES konektag.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_social_boost_pricing_channel_country_unique UNIQUE (channel, target_country),
  CONSTRAINT merchant_social_boost_pricing_country_code_check CHECK (target_country ~ '^[A-Z]{2}$'),
  CONSTRAINT merchant_social_boost_pricing_channel_check CHECK (length(trim(channel)) BETWEEN 1 AND 80),
  CONSTRAINT merchant_social_boost_pricing_item_code_check CHECK (length(trim(erpnext_item_code)) BETWEEN 1 AND 140),
  CONSTRAINT merchant_social_boost_pricing_price_list_check CHECK (length(trim(price_list)) BETWEEN 1 AND 140),
  CONSTRAINT merchant_social_boost_pricing_country_name_check CHECK (length(trim(target_country_name)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS merchant_social_boost_pricing_active_country_idx
  ON konektag.merchant_social_boost_pricing (target_country, channel)
  WHERE is_active = TRUE;

COMMIT;
