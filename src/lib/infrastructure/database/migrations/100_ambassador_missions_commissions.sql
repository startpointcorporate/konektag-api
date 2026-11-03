-- Migration 100: Ambassador, mission, evidence, and commission domains.
BEGIN;

ALTER TABLE konektag.agent_inquiries
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES konektag.users(id),
    ADD COLUMN IF NOT EXISTS merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id),
    ADD COLUMN IF NOT EXISTS manager_name VARCHAR(200),
    ADD COLUMN IF NOT EXISTS city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS full_address VARCHAR(500),
    ADD COLUMN IF NOT EXISTS activity_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS estimated_client_volume INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS available_space VARCHAR(500),
    ADD COLUMN IF NOT EXISTS opening_hours VARCHAR(500),
    ADD COLUMN IF NOT EXISTS justificatif_file VARCHAR(500),
    ADD COLUMN IF NOT EXISTS motivation TEXT,
    ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES konektag.users(id);

CREATE INDEX IF NOT EXISTS idx_agent_inquiries_owner
    ON konektag.agent_inquiries(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_inquiries_merchant
    ON konektag.agent_inquiries(merchant_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS konektag.ambassador_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES konektag.users(id),
    merchant_profile_id UUID UNIQUE REFERENCES konektag.merchant_profiles(id),
    display_name VARCHAR(200) NOT NULL,
    email VARCHAR(200),
    phone VARCHAR(30),
    ambassador_type VARCHAR(20) NOT NULL CHECK (ambassador_type IN ('Representative', 'Agent', 'Both')),
    country VARCHAR(100),
    city VARCHAR(100),
    area VARCHAR(100),
    status VARCHAR(10) NOT NULL DEFAULT 'Actif' CHECK (status IN ('Actif', 'Inactif')),
    max_active_missions INTEGER NOT NULL DEFAULT 3 CHECK (max_active_missions >= 0),
    commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO konektag.ambassador_profiles
    (user_id, merchant_profile_id, display_name, email, phone, ambassador_type,
     country, city, status, max_active_missions, commission_rate)
SELECT mp.user_id, mp.id, mp.business_name, mp.email, mp.phone, 'Agent',
       mp.country, mp.city, 'Actif', 0, COALESCE(r.commission_rate, 1)
FROM konektag.merchant_profiles mp
LEFT JOIN LATERAL (
    SELECT commission_rate FROM konektag.agent_commission_rates
    WHERE merchant_profile_id = mp.id AND is_active = true
    ORDER BY updated_at DESC LIMIT 1
) r ON true
WHERE mp.agent_enabled = true AND mp.deleted_at IS NULL AND mp.user_id IS NOT NULL
ON CONFLICT (user_id) DO UPDATE SET
    merchant_profile_id = EXCLUDED.merchant_profile_id,
    ambassador_type = CASE
        WHEN konektag.ambassador_profiles.ambassador_type = 'Representative' THEN 'Both'
        ELSE konektag.ambassador_profiles.ambassador_type
    END,
    updated_at = now();

CREATE INDEX IF NOT EXISTS idx_ambassador_profiles_directory
    ON konektag.ambassador_profiles(ambassador_type, status, country, city, area);

CREATE TABLE IF NOT EXISTS konektag.field_missions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_name VARCHAR(200) NOT NULL,
    merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id),
    merchant_business_name VARCHAR(200) NOT NULL DEFAULT '',
    mission_type VARCHAR(20) NOT NULL CHECK (mission_type IN ('Verification', 'Completion', 'Media', 'Validation')),
    activity_type VARCHAR(20) NOT NULL CHECK (activity_type IN ('Restaurant', 'Hotel', 'Commerce')),
    country VARCHAR(100) NOT NULL DEFAULT '',
    city VARCHAR(100) NOT NULL DEFAULT '',
    address VARCHAR(500) NOT NULL DEFAULT '',
    priority VARCHAR(10) NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
    deadline_hours INTEGER NOT NULL DEFAULT 48 CHECK (deadline_hours > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available', 'Reserved', 'InProgress', 'Submitted', 'Approved', 'Rejected', 'Expired', 'Paid')),
    representative_id UUID REFERENCES konektag.ambassador_profiles(id),
    reserved_at TIMESTAMPTZ,
    reservation_expires_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES konektag.users(id),
    reward_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
    currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    commission_rule VARCHAR(200) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_missions_available
    ON konektag.field_missions(country, city, mission_type, priority, created_at DESC)
    WHERE status = 'Available';
CREATE INDEX IF NOT EXISTS idx_field_missions_representative
    ON konektag.field_missions(representative_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_missions_active_representative
    ON konektag.field_missions(representative_id, reservation_expires_at)
    WHERE status IN ('Reserved', 'InProgress');

CREATE TABLE IF NOT EXISTS konektag.mission_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_id UUID NOT NULL REFERENCES konektag.field_missions(id) ON DELETE CASCADE,
    evidence_type VARCHAR(20) NOT NULL CHECK (evidence_type IN ('Photo', 'Video', 'Document', 'CustomerReview', 'Comment')),
    file_url VARCHAR(500) NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    submitted_by UUID NOT NULL REFERENCES konektag.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (length(trim(file_url)) > 0 OR length(trim(comment)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_mission_evidence_mission ON konektag.mission_evidence(mission_id, created_at);

CREATE TABLE IF NOT EXISTS konektag.ambassador_commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ambassador_id UUID NOT NULL REFERENCES konektag.ambassador_profiles(id),
    commission_type VARCHAR(30) NOT NULL CHECK (commission_type IN ('RepresentativeMission', 'AgentWithdrawal')),
    status VARCHAR(10) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Calcule', 'Valide', 'Paye', 'Rejete')),
    mission_id UUID REFERENCES konektag.field_missions(id),
    withdrawal_ref VARCHAR(200),
    gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    wallet_transaction_ref VARCHAR(200) NOT NULL DEFAULT '',
    payment_date TIMESTAMPTZ,
    period_start DATE,
    period_end DATE,
    blnk_entry_id VARCHAR(200) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (commission_amount >= 0),
    CHECK (commission_rate >= 0),
    CHECK (
        (commission_type = 'RepresentativeMission' AND mission_id IS NOT NULL AND withdrawal_ref IS NULL)
        OR (commission_type = 'AgentWithdrawal' AND mission_id IS NULL AND withdrawal_ref IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_ambassador_commissions_read
    ON konektag.ambassador_commissions(ambassador_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambassador_commissions_mission_unique
    ON konektag.ambassador_commissions(mission_id)
    WHERE commission_type = 'RepresentativeMission' AND mission_id IS NOT NULL;

COMMIT;
