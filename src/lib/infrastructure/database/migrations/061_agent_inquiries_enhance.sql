ALTER TABLE konektag.agent_inquiries ADD COLUMN IF NOT EXISTS merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id);
ALTER TABLE konektag.agent_inquiries ADD COLUMN IF NOT EXISTS motivation TEXT;
ALTER TABLE konektag.agent_inquiries ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE konektag.agent_inquiries ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
