BEGIN;
CREATE TABLE konektag.merchant_social_campaigns (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
 created_by UUID NOT NULL REFERENCES konektag.users(id), request_key UUID NOT NULL,
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1800), channel VARCHAR(30) NOT NULL CHECK(channel IN ('facebook','instagram','instagram-standalone')),
 public_snapshot JSONB NOT NULL, snapshot_hash VARCHAR(64) NOT NULL,
 tracked_url TEXT NOT NULL, state VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','APPROVED','SENDING','SCHEDULED','PUBLISHED','FAILED','UNCERTAIN','CANCELLED')),
 version INTEGER NOT NULL DEFAULT 1, approved_by UUID REFERENCES konektag.users(id), approved_at TIMESTAMPTZ,
 scheduled_at TIMESTAMPTZ, provider_post_id TEXT, provider_integration_id TEXT, last_error VARCHAR(100),
 provider_url TEXT, provider_checked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(merchant_profile_id,request_key)
);
CREATE INDEX merchant_social_campaign_history ON konektag.merchant_social_campaigns(merchant_profile_id,created_at DESC);
CREATE TABLE konektag.merchant_social_campaign_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id UUID NOT NULL REFERENCES konektag.merchant_social_campaigns(id),
 actor_id UUID REFERENCES konektag.users(id),action VARCHAR(40) NOT NULL,version INTEGER NOT NULL,payload JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE konektag.review_merchant_replies (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), review_id UUID NOT NULL REFERENCES konektag.reviews(id),
 actor_id UUID NOT NULL REFERENCES konektag.users(id),content VARCHAR(2000) NOT NULL CHECK(length(trim(content))>0),
 version INTEGER NOT NULL CHECK(version>0),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(review_id,version)
);
CREATE TABLE konektag.review_reports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),review_id UUID NOT NULL REFERENCES konektag.reviews(id),reporter_id UUID NOT NULL REFERENCES konektag.users(id),
 reason VARCHAR(20) NOT NULL CHECK(reason IN ('SPAM','ABUSE','CONFLICT','OTHER')),details VARCHAR(2000),
 state VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','DISMISSED','HIDDEN')),
 resolved_by UUID REFERENCES konektag.users(id),resolution_reason VARCHAR(2000),resolved_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(review_id,reporter_id)
);
CREATE TABLE konektag.review_moderation_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),revision BIGSERIAL UNIQUE,review_id UUID NOT NULL REFERENCES konektag.reviews(id),actor_id UUID NOT NULL REFERENCES konektag.users(id),
 state VARCHAR(10) NOT NULL CHECK(state IN ('VISIBLE','HIDDEN')),reason VARCHAR(2000) NOT NULL CHECK(length(trim(reason))>0),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_moderation_latest ON konektag.review_moderation_events(review_id,revision DESC);
CREATE TABLE konektag.merchant_search_observations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),actor_id UUID NOT NULL REFERENCES konektag.users(id),
 engine VARCHAR(10) NOT NULL CHECK(engine IN ('GOOGLE','BING')),result VARCHAR(20) NOT NULL CHECK(result IN ('INDEXED','NOT_INDEXED','UNKNOWN')),
 inspected_url TEXT NOT NULL,source_url TEXT NOT NULL,observed_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE konektag.merchant_indexnow_attempts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),actor_id UUID NOT NULL REFERENCES konektag.users(id),
 url TEXT NOT NULL,state VARCHAR(15) NOT NULL CHECK(state IN ('SUBMITTED','SKIPPED','FAILED')),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION konektag.reject_visibility_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'VISIBILITY_HISTORY_IMMUTABLE'; END; $$;
CREATE TRIGGER social_campaign_events_immutable BEFORE UPDATE OR DELETE ON konektag.merchant_social_campaign_events FOR EACH ROW EXECUTE FUNCTION konektag.reject_visibility_history_mutation();
CREATE TRIGGER review_replies_immutable BEFORE UPDATE OR DELETE ON konektag.review_merchant_replies FOR EACH ROW EXECUTE FUNCTION konektag.reject_visibility_history_mutation();
CREATE TRIGGER review_moderation_immutable BEFORE UPDATE OR DELETE ON konektag.review_moderation_events FOR EACH ROW EXECUTE FUNCTION konektag.reject_visibility_history_mutation();
CREATE TRIGGER search_observations_immutable BEFORE UPDATE OR DELETE ON konektag.merchant_search_observations FOR EACH ROW EXECUTE FUNCTION konektag.reject_visibility_history_mutation();
COMMIT;
