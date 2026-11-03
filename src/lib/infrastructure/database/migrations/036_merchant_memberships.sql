-- Migration 036 : Merchant memberships — relation N:N utilisateurs ↔ commerces
-- Remplace progressivement merchant_profiles.user_id (propriétaire unique)
-- par une table de jointure avec rôles et statuts.

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Création de la table
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS konektag.merchant_memberships (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
    user_id             UUID NOT NULL REFERENCES konektag.users(id),
    role                VARCHAR(50) NOT NULL DEFAULT 'manager'
                        CHECK (role IN ('owner', 'manager', 'marketing', 'accountant', 'employee')),
    status              VARCHAR(30) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    approved_at         TIMESTAMPTZ,
    removed_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          VARCHAR(255),
    UNIQUE(merchant_profile_id, user_id)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_memberships_profile ON konektag.merchant_memberships(merchant_profile_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON konektag.merchant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_status ON konektag.merchant_memberships(status);
CREATE INDEX IF NOT EXISTS idx_memberships_role ON konektag.merchant_memberships(role);

-- Index partiel : un seul owner primaire actif par commerce
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_primary_owner
    ON konektag.merchant_memberships(merchant_profile_id)
    WHERE role = 'owner' AND is_primary = true AND status = 'active';

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_memberships_updated_at ON konektag.merchant_memberships;
CREATE TRIGGER trg_memberships_updated_at
    BEFORE UPDATE ON konektag.merchant_memberships
    FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- 2. Backfill des propriétaires existants
-- ═══════════════════════════════════════════════════════════════
-- Pour chaque merchant_profiles.user_id non null, créer une membership owner active.
-- Idempotent : ON CONFLICT ne fait rien.

INSERT INTO konektag.merchant_memberships
    (merchant_profile_id, user_id, role, status, is_primary, approved_at, created_by)
SELECT
    mp.id,
    mp.user_id,
    'owner',
    'active',
    true,
    COALESCE(mp.created_at, now()),
    'migration-036'
FROM konektag.merchant_profiles mp
WHERE mp.user_id IS NOT NULL
  AND mp.deleted_at IS NULL
ON CONFLICT (merchant_profile_id, user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 3. Vérifications
-- ═══════════════════════════════════════════════════════════════
-- Compter les backfills
SELECT 'backfill' AS step, count(*) AS rows FROM konektag.merchant_memberships;

-- Vérifier les doublons
SELECT 'duplicates' AS check_name, merchant_profile_id FROM konektag.merchant_memberships
    GROUP BY merchant_profile_id HAVING count(*) > 1;

-- Vérifier les memberships orphelines
SELECT 'orphans' AS check_name, mm.id FROM konektag.merchant_memberships mm
    LEFT JOIN konektag.merchant_profiles mp ON mp.id = mm.merchant_profile_id
    WHERE mp.id IS NULL;

COMMIT;
