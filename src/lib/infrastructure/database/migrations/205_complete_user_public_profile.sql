ALTER TABLE konektag.user_public_profiles ADD COLUMN IF NOT EXISTS public_first_name VARCHAR(120);
ALTER TABLE konektag.user_public_profiles ADD COLUMN IF NOT EXISTS public_last_name VARCHAR(120);
ALTER TABLE konektag.user_public_profiles ADD COLUMN IF NOT EXISTS public_phone VARCHAR(80);
ALTER TABLE konektag.user_public_profiles ADD COLUMN IF NOT EXISTS public_email VARCHAR(320);
CREATE TABLE IF NOT EXISTS konektag.user_public_media(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,url VARCHAR(1000) NOT NULL,alt_text VARCHAR(240),display_order INT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS konektag.user_public_external_links(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,label VARCHAR(160),url VARCHAR(1000) NOT NULL,display_order INT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS konektag.user_public_activities(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,label VARCHAR(200) NOT NULL,display_order INT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
