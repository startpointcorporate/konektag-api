-- Migration 069 : Protection append-only sur audit_logs
-- Empeche toute modification ou suppression des logs d'audit
-- Idempotent

BEGIN;

-- Trigger BEFORE UPDATE — refuse toute modification
CREATE OR REPLACE FUNCTION konektag.prevent_audit_log_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs are append-only: UPDATE is forbidden on konektag.audit_logs';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON konektag.audit_logs;
CREATE TRIGGER trg_audit_logs_no_update
    BEFORE UPDATE ON konektag.audit_logs
    FOR EACH ROW EXECUTE FUNCTION konektag.prevent_audit_log_update();

-- Trigger BEFORE DELETE — refuse toute suppression
CREATE OR REPLACE FUNCTION konektag.prevent_audit_log_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs are append-only: DELETE is forbidden on konektag.audit_logs';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_delete ON konektag.audit_logs;
CREATE TRIGGER trg_audit_logs_no_delete
    BEFORE DELETE ON konektag.audit_logs
    FOR EACH ROW EXECUTE FUNCTION konektag.prevent_audit_log_delete();

COMMIT;
