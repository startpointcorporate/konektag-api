-- Migration: merchant_pro_subscriptions table
-- Created at: 2024-08-20

CREATE TABLE IF NOT EXISTS konektag.merchant_pro_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
    subscription_start DATE NOT NULL,
    subscription_end DATE,
    subscription_type VARCHAR(10) NOT NULL, -- 'MONTHLY', 'ANNUAL'
    status VARCHAR(20) NOT NULL, -- 'ACTIVE', 'INACTIVE', 'EXPIRED'
    renewal_requested BOOLEAN DEFAULT FALSE,
    renewal_type VARCHAR(10),
    auto_renew BOOLEAN DEFAULT FALSE,
    annual_discount_applied BOOLEAN DEFAULT FALSE,
    first_activation BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index on merchant_profile_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_merchant_pro_subscriptions_profile_id ON konektag.merchant_pro_subscriptions(merchant_profile_id);

-- Create index on status for filtering active subscriptions
CREATE INDEX IF NOT EXISTS idx_merchant_pro_subscriptions_status ON konektag.merchant_pro_subscriptions(status);

-- Create index on subscription_end for expiration checks
CREATE INDEX IF NOT EXISTS idx_merchant_pro_subscriptions_end_date ON konektag.merchant_pro_subscriptions(subscription_end);

COMMENT ON TABLE konektag.merchant_pro_subscriptions IS 'Table to store merchant Pro subscriptions';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.merchant_profile_id IS 'Reference to the merchant profile';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.subscription_start IS 'Start date of the subscription';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.subscription_end IS 'End date of the subscription';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.subscription_type IS 'Type of subscription: MONTHLY or ANNUAL';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.status IS 'Current status of subscription: ACTIVE, INACTIVE, EXPIRED';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.renewal_requested IS 'Flag indicating if a renewal has been requested by the merchant';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.renewal_type IS 'Type of renewal requested: MONTHLY or ANNUAL';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.auto_renew IS 'Flag for automatic renewal';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.annual_discount_applied IS 'Flag indicating if annual discount was applied';
COMMENT ON COLUMN konektag.merchant_pro_subscriptions.first_activation IS 'Flag indicating if this is the first activation of Pro';