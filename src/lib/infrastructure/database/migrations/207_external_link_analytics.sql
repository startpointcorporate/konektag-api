-- Track clicks on merchant external links and social networks.
ALTER TABLE konektag.profile_analytics DROP CONSTRAINT IF EXISTS profile_analytics_event_type_check;
ALTER TABLE konektag.profile_analytics
  ADD CONSTRAINT profile_analytics_event_type_check CHECK(event_type IN
  ('view','phone_click','direction_click','message_sent','external_link_click',
   'city_availability_viewed','city_follow_clicked','city_follow_pending_created','city_follow_completed',
   'city_follow_disabled','city_follow_reactivated','city_follow_cancelled','city_marketplace_revisited',
   'city_follow_registration_started','city_follow_registration_succeeded','city_follow_login_succeeded'));

ALTER TABLE konektag.profile_analytics ADD COLUMN IF NOT EXISTS external_link_id UUID REFERENCES konektag.merchant_external_links(id) ON DELETE SET NULL;
ALTER TABLE konektag.profile_analytics ADD COLUMN IF NOT EXISTS event_metadata JSONB;
CREATE INDEX IF NOT EXISTS idx_profile_analytics_external_link
  ON konektag.profile_analytics(profile_id, external_link_id, created_at DESC)
  WHERE event_type='external_link_click';
