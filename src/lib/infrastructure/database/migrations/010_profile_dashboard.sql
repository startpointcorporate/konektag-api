-- Migration 010 : Profile types, country modules, dashboard config enhancements
-- Version : 1.0 | Idempotent

-- ═══ Profile type ═══
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS profile_type VARCHAR(20) NOT NULL DEFAULT 'personal'
    CHECK (profile_type IN ('personal', 'professional', 'ambassador', 'agent'));

ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS country VARCHAR(5);
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS city VARCHAR(100);

-- ═══ Country modules ═══
CREATE TABLE IF NOT EXISTS konektag.country_modules (
    country_code VARCHAR(5) NOT NULL,
    module_key VARCHAR(50) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (country_code, module_key)
);

-- Seed country modules
INSERT INTO konektag.country_modules (country_code, module_key, is_active) VALUES
    ('CG', 'mobile_money', true),
    ('CG', 'stripe', true),
    ('CG', 'crypto', false),
    ('CG', 'restaurants', true),
    ('CG', 'hotels', true),
    ('CG', 'shops', true),
    ('CG', 'events', true),
    ('CG', 'promos', true),
    ('CG', 'missions', true),
    ('CG', 'agent_services', true),
    ('AO', 'mobile_money', true),
    ('AO', 'stripe', true),
    ('AO', 'crypto', true),
    ('AO', 'restaurants', true),
    ('AO', 'hotels', true),
    ('AO', 'shops', true),
    ('AO', 'events', true),
    ('AO', 'promos', true),
    ('AO', 'missions', true),
    ('AO', 'agent_services', false),
    ('FR', 'mobile_money', false),
    ('FR', 'stripe', true),
    ('FR', 'crypto', true),
    ('FR', 'restaurants', true),
    ('FR', 'hotels', true),
    ('FR', 'shops', true),
    ('FR', 'events', true),
    ('FR', 'promos', true),
    ('FR', 'missions', false),
    ('FR', 'agent_services', false),
    ('LB', 'mobile_money', true),
    ('LB', 'stripe', true),
    ('LB', 'crypto', true),
    ('LB', 'restaurants', true),
    ('LB', 'hotels', true),
    ('LB', 'shops', true),
    ('LB', 'events', true),
    ('LB', 'promos', true),
    ('LB', 'missions', false),
    ('LB', 'agent_services', false)
ON CONFLICT (country_code, module_key) DO NOTHING;

-- ═══ Enhanced dashboard_config ═══
ALTER TABLE konektag.dashboard_config ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'personal';
ALTER TABLE konektag.dashboard_config ADD COLUMN IF NOT EXISTS hidden_widgets JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE konektag.dashboard_config ADD COLUMN IF NOT EXISTS customization_date TIMESTAMPTZ;

-- ═══ Usage tracking for intelligent dashboard ═══
CREATE TABLE IF NOT EXISTS konektag.widget_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    widget_key VARCHAR(50) NOT NULL,
    accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_usage_user ON konektag.widget_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_widget_usage_user_widget ON konektag.widget_usage(user_id, widget_key);

-- Updated_at trigger for country_modules
DROP TRIGGER IF EXISTS country_modules_updated_at ON konektag.country_modules;
CREATE TRIGGER country_modules_updated_at BEFORE UPDATE ON konektag.country_modules
    FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();

ALTER TABLE konektag.dashboard_config DROP CONSTRAINT IF EXISTS dashboard_config_role_check;
ALTER TABLE konektag.dashboard_config ADD CONSTRAINT dashboard_config_role_check
    CHECK (role IN ('personal', 'professional', 'ambassador', 'agent'));
