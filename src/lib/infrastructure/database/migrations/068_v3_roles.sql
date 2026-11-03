-- Migration 068 : Roles V3 — remplace le binaire user/admin
-- Ajoute : support, operations, compliance, finance_local,
--          finance_groupe, approver, admin_technique
-- Idempotent

BEGIN;

-- Mettre a jour la contrainte CHECK sur konektag.users.role
ALTER TABLE konektag.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE konektag.users ADD CONSTRAINT users_role_check
    CHECK (role IN (
        'user',
        'admin',
        'support',
        'operations',
        'compliance',
        'finance_local',
        'finance_groupe',
        'approver',
        'admin_technique'
    ));

-- Migrer les admins existants vers admin_technique (role de transition)
-- Le role 'admin' est conserve pour compatibilite mais devra etre migre
-- vers les roles specifiques. Voir Lot 6 pour la migration complete.

COMMIT;
