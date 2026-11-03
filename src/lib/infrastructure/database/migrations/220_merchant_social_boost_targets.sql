BEGIN;

CREATE TABLE IF NOT EXISTS konektag.merchant_social_boost_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boost_id UUID NOT NULL REFERENCES konektag.merchant_social_boosts(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES konektag.merchant_social_campaigns(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  target_country VARCHAR(2),
  target_country_name TEXT,
  budget_minor BIGINT NOT NULL CHECK (budget_minor >= 0),
  cpm_minor BIGINT NOT NULL CHECK (cpm_minor > 0),
  item_code VARCHAR(140) NOT NULL,
  theoretical_impressions BIGINT NOT NULL CHECK (theoretical_impressions >= 0),
  tracking_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_boost_target_boost
  ON konektag.merchant_social_boost_targets(boost_id);
CREATE INDEX IF NOT EXISTS idx_social_boost_target_campaign
  ON konektag.merchant_social_boost_targets(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_boost_target_market_unique
  ON konektag.merchant_social_boost_targets(boost_id,campaign_id,target_country)
  WHERE target_country IS NOT NULL;

-- Preserve existing dev/test records as a single legacy target when this migration is applied.
INSERT INTO konektag.merchant_social_boost_targets
  (boost_id,campaign_id,channel,target_country,budget_minor,cpm_minor,item_code,theoretical_impressions,tracking_url)
SELECT b.id,b.campaign_id,c.channel,NULL,b.budget_minor,
       COALESCE(NULLIF(p.line->>'cpm_minor','')::bigint,1),
       COALESCE(NULLIF(p.line->>'item_code',''), 'LEGACY-BOOST'),
       COALESCE(b.theoretical_impressions,0),b.tracking_url
FROM konektag.merchant_social_boosts b
JOIN konektag.merchant_social_campaigns c ON c.id=b.campaign_id
LEFT JOIN LATERAL (SELECT line FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.pricing_snapshot)='array' THEN b.pricing_snapshot ELSE '[]'::jsonb END) line LIMIT 1) p ON true
WHERE NOT EXISTS (SELECT 1 FROM konektag.merchant_social_boost_targets t WHERE t.boost_id=b.id);

COMMIT;
