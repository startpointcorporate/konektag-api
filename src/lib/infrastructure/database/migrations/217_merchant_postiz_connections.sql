BEGIN;
CREATE TABLE konektag.postiz_connections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(120) NOT NULL,
 api_url TEXT, credential_env VARCHAR(100) NOT NULL CHECK(credential_env ~ '^POSTIZ_API_KEY(_[A-Z0-9_]+)?$'),
 active BOOLEAN NOT NULL DEFAULT true, is_default BOOLEAN NOT NULL DEFAULT false,
 created_by UUID REFERENCES konektag.users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((is_default AND api_url IS NULL AND credential_env='POSTIZ_API_KEY') OR (NOT is_default AND api_url IS NOT NULL))
);
CREATE UNIQUE INDEX postiz_one_default ON konektag.postiz_connections(is_default) WHERE is_default;
INSERT INTO konektag.postiz_connections(id,name,credential_env,is_default)
 VALUES('00000000-0000-4000-8000-000000000001','Postiz Konektag','POSTIZ_API_KEY',true);
CREATE TABLE konektag.merchant_postiz_settings (
 merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id),
 connection_id UUID NOT NULL REFERENCES konektag.postiz_connections(id),
 channels JSONB NOT NULL CHECK(jsonb_typeof(channels)='object'), direct_publish BOOLEAN NOT NULL DEFAULT false,
 use_default BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by UUID NOT NULL REFERENCES konektag.users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(NOT(use_default AND direct_publish))
);
CREATE TABLE konektag.postiz_configuration_events (
 id BIGSERIAL PRIMARY KEY, actor_id UUID NOT NULL REFERENCES konektag.users(id),
 merchant_profile_id UUID REFERENCES konektag.merchant_profiles(id), connection_id UUID REFERENCES konektag.postiz_connections(id),
 action VARCHAR(40) NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER postiz_config_events_immutable BEFORE UPDATE OR DELETE ON konektag.postiz_configuration_events
 FOR EACH ROW EXECUTE FUNCTION konektag.reject_visibility_history_mutation();
-- Connection endpoint / credential references are immutable; create a new connection to move an instance.
CREATE FUNCTION konektag.guard_postiz_connection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') THEN
 RAISE EXCEPTION 'POSTIZ_CONNECTION_IDENTITY_IMMUTABLE'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER postiz_connection_identity BEFORE UPDATE OR DELETE ON konektag.postiz_connections
 FOR EACH ROW EXECUTE FUNCTION konektag.guard_postiz_connection();
ALTER TABLE konektag.merchant_social_campaigns
 ADD COLUMN connection_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES konektag.postiz_connections(id),
 ADD COLUMN destination_snapshot JSONB,
 ADD COLUMN destination_version INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN requires_approval BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN cancellation_requested_at TIMESTAMPTZ;
ALTER TABLE konektag.merchant_social_campaigns DROP CONSTRAINT merchant_social_campaigns_state_check;
ALTER TABLE konektag.merchant_social_campaigns ADD CONSTRAINT merchant_social_campaigns_state_check
 CHECK(state IN ('DRAFT','APPROVED','SENDING','SCHEDULED','PUBLISHED','FAILED','UNCERTAIN','CANCELLED','CANCELLING','CANCEL_UNCERTAIN'));
CREATE INDEX postiz_campaign_sync_pending ON konektag.merchant_social_campaigns(provider_checked_at,created_at)
 WHERE state IN ('SENDING','SCHEDULED','UNCERTAIN','CANCELLING','CANCEL_UNCERTAIN');
COMMIT;
