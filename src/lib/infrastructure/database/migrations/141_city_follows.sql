BEGIN;
CREATE TABLE konektag.cities (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), country_code VARCHAR(2) NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 name TEXT NOT NULL, normalized_name TEXT NOT NULL, UNIQUE(country_code,normalized_name), UNIQUE(id,country_code)
);
INSERT INTO konektag.cities(country_code,name,normalized_name)
SELECT country,name,lower(name) FROM (VALUES ('CM','Yaoundé'),('CM','Douala'),('CG','Pointe-Noire'),('CG','Brazzaville'),('CD','Kinshasa'),('GA','Libreville'),('AO','Luanda'),('GN','Conakry'),('CF','Bangui')) AS seed(country,name);
INSERT INTO konektag.cities(country_code,name,normalized_name)
SELECT upper(trim(country)),min(trim(city)),lower(trim(city)) FROM konektag.merchant_profiles
WHERE trim(country) ~ '^[A-Za-z]{2}$' AND nullif(trim(city),'') IS NOT NULL
GROUP BY upper(trim(country)),lower(trim(city)) ON CONFLICT DO NOTHING;
ALTER TABLE konektag.merchant_profiles ADD COLUMN city_id UUID REFERENCES konektag.cities(id);
UPDATE konektag.merchant_profiles m SET city_id=c.id FROM konektag.cities c
WHERE c.country_code=upper(trim(m.country)) AND c.normalized_name=lower(trim(m.city));
CREATE FUNCTION konektag.assign_merchant_city() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (NEW.country,NEW.city) IS DISTINCT FROM (OLD.country,OLD.city) THEN
  NEW.city_id=NULL;
  IF trim(NEW.country) ~ '^[A-Za-z]{2}$' AND nullif(trim(NEW.city),'') IS NOT NULL THEN
   INSERT INTO konektag.cities(country_code,name,normalized_name) VALUES(upper(trim(NEW.country)),trim(NEW.city),lower(trim(NEW.city))) ON CONFLICT DO NOTHING;
   SELECT id INTO NEW.city_id FROM konektag.cities WHERE country_code=upper(trim(NEW.country)) AND normalized_name=lower(trim(NEW.city));
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assign_merchant_city BEFORE INSERT OR UPDATE OF country,city ON konektag.merchant_profiles FOR EACH ROW EXECUTE FUNCTION konektag.assign_merchant_city();
-- Canonical business rule: approved ownership, active owner membership, existing owner, non-suspended shop.
-- Draft is intentional: admin approval currently puts a claimed shop in Draft.
CREATE VIEW konektag.city_validated_shops AS
SELECT m.id AS merchant_profile_id,m.city_id FROM konektag.merchant_profiles m
WHERE m.deleted_at IS NULL AND m.status NOT IN ('Suspended','Referenced') AND m.city_id IS NOT NULL
AND EXISTS(SELECT 1 FROM konektag.merchant_memberships mm
 JOIN konektag.merchant_claims claim ON claim.merchant_profile_id=mm.merchant_profile_id AND claim.user_id=mm.user_id AND claim.status='approved'
 JOIN konektag.users u ON u.id=mm.user_id AND u.deleted_at IS NULL
 WHERE mm.merchant_profile_id=m.id AND mm.role='owner' AND mm.status='active' AND mm.removed_at IS NULL);
CREATE TABLE konektag.city_follows (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES konektag.users(id),party_id UUID REFERENCES konektag.parties(id),
 city_id UUID NOT NULL,country_code VARCHAR(2) NOT NULL,city_name_at_signup TEXT NOT NULL,city_name_normalized TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT true,notifications_enabled BOOLEAN NOT NULL DEFAULT true,
 subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),source TEXT NOT NULL,consent_version TEXT NOT NULL,consented_at TIMESTAMPTZ NOT NULL,
 deactivated_at TIMESTAMPTZ,reactivated_at TIMESTAMPTZ,threshold_at_signup INTEGER NOT NULL,availability_at_signup TEXT NOT NULL CHECK(availability_at_signup IN ('LIMITED','AVAILABLE')),
 UNIQUE(user_id,city_id),FOREIGN KEY(city_id,country_code) REFERENCES konektag.cities(id,country_code)
);
CREATE TABLE konektag.city_follow_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),follow_id UUID NOT NULL REFERENCES konektag.city_follows(id),
 action TEXT NOT NULL,active BOOLEAN NOT NULL,notifications_enabled BOOLEAN NOT NULL,source TEXT NOT NULL,consent_version TEXT NOT NULL,consented_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE konektag.city_follow_intents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),token_hash TEXT NOT NULL,city_id UUID NOT NULL,country_code VARCHAR(2) NOT NULL,
 return_path TEXT NOT NULL CHECK(return_path ~ '^/[a-z]{2}/marketplace/\?'),action TEXT NOT NULL CHECK(action='follow_city'),
 source TEXT NOT NULL,consent_version TEXT NOT NULL,clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,registration_started_at TIMESTAMPTZ,
 FOREIGN KEY(city_id,country_code) REFERENCES konektag.cities(id,country_code)
);
CREATE INDEX city_follow_intents_expiration ON konektag.city_follow_intents(expires_at);
CREATE TABLE konektag.city_shop_activations (
 merchant_profile_id UUID PRIMARY KEY REFERENCES konektag.merchant_profiles(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing shops are a baseline, not a new merchant notification campaign.
INSERT INTO konektag.city_shop_activations(merchant_profile_id) SELECT merchant_profile_id FROM konektag.city_validated_shops;
CREATE TABLE konektag.city_merchant_notifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES konektag.users(id),follow_id UUID NOT NULL REFERENCES konektag.city_follows(id),
 city_id UUID NOT NULL REFERENCES konektag.cities(id),merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
 event_type TEXT NOT NULL DEFAULT 'city_merchant_available',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','cancelled')),
 UNIQUE(user_id,merchant_profile_id)
);
CREATE FUNCTION konektag.prepare_city_merchant_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 WITH newly_active AS (
  INSERT INTO konektag.city_shop_activations(merchant_profile_id)
  SELECT merchant_profile_id FROM konektag.city_validated_shops ON CONFLICT DO NOTHING RETURNING merchant_profile_id
 )
 INSERT INTO konektag.city_merchant_notifications(user_id,follow_id,city_id,merchant_profile_id)
 SELECT f.user_id,f.id,f.city_id,n.merchant_profile_id FROM newly_active n
 JOIN konektag.city_validated_shops v USING(merchant_profile_id) JOIN konektag.city_follows f ON f.city_id=v.city_id
 JOIN konektag.users u ON u.id=f.user_id AND u.deleted_at IS NULL AND u.access_status IS DISTINCT FROM 'BLOCKED'
 WHERE f.active AND f.notifications_enabled ON CONFLICT DO NOTHING;
 UPDATE konektag.city_merchant_notifications n SET status='cancelled' WHERE n.status='prepared'
 AND (NOT EXISTS(SELECT 1 FROM konektag.city_validated_shops v WHERE v.merchant_profile_id=n.merchant_profile_id AND v.city_id=n.city_id)
 OR NOT EXISTS(SELECT 1 FROM konektag.city_follows f JOIN konektag.users u ON u.id=f.user_id WHERE f.id=n.follow_id AND f.active AND f.notifications_enabled AND u.deleted_at IS NULL AND u.access_status IS DISTINCT FROM 'BLOCKED'));
 RETURN NULL;
END $$;
CREATE TRIGGER city_notification_shops AFTER INSERT OR UPDATE OR DELETE ON konektag.merchant_profiles FOR EACH STATEMENT EXECUTE FUNCTION konektag.prepare_city_merchant_notifications();
CREATE TRIGGER city_notification_claims AFTER INSERT OR UPDATE OR DELETE ON konektag.merchant_claims FOR EACH STATEMENT EXECUTE FUNCTION konektag.prepare_city_merchant_notifications();
CREATE TRIGGER city_notification_memberships AFTER INSERT OR UPDATE OR DELETE ON konektag.merchant_memberships FOR EACH STATEMENT EXECUTE FUNCTION konektag.prepare_city_merchant_notifications();
CREATE TRIGGER city_notification_follows AFTER UPDATE ON konektag.city_follows FOR EACH STATEMENT EXECUTE FUNCTION konektag.prepare_city_merchant_notifications();
CREATE TRIGGER city_notification_users AFTER UPDATE ON konektag.users FOR EACH STATEMENT EXECUTE FUNCTION konektag.prepare_city_merchant_notifications();
ALTER TABLE konektag.profile_analytics ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE konektag.profile_analytics ADD COLUMN city_id UUID REFERENCES konektag.cities(id),ADD COLUMN metadata JSONB;
ALTER TABLE konektag.profile_analytics DROP CONSTRAINT profile_analytics_event_type_check;
ALTER TABLE konektag.profile_analytics ADD CONSTRAINT profile_analytics_event_type_check CHECK(event_type IN
('view','phone_click','direction_click','message_sent','city_availability_viewed','city_follow_clicked','city_follow_pending_created','city_follow_completed','city_follow_disabled','city_follow_reactivated','city_follow_cancelled','city_marketplace_revisited','city_follow_registration_started','city_follow_registration_succeeded','city_follow_login_succeeded'));
COMMIT;
