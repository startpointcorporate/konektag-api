-- 056_activation_challenge_permanent.sql
-- Make the existing challenge campaign permanent, activating it and removing blocking duration constraints.
-- The campaign 'challenge-100-eur-summer-2026' will:
--  * be set to status 'active'
--  * have ends_at set to the SQL infinite timestamp, meaning no deadline
--  * keep the same milestones and points, but adjust the 4th milestone target amount to 150
--  * preserve all existing progress and bonuses
--
-- This migration does not alter the table definition itself, keeping all existing columns for compatibility.

BEGIN;

-- Activate the campaign and set an infinite end date
UPDATE konektag.activation_campaigns
SET status = 'active',
    ends_at = 'infinity'::timestamptz
WHERE internal_name = 'challenge-100-eur-summer-2026';

-- Adjust the 4th milestone target amount from 250 to 150
UPDATE konektag.activation_milestones m
SET target_amount = 150
WHERE m.campaign_id = (
      SELECT id
      FROM konektag.activation_campaigns
      WHERE internal_name = 'challenge-100-eur-summer-2026'
  )
  AND m.metric_type = 'MerchantPayment'
  AND m.sort_order = 4;

-- Make existing challenges permanent
UPDATE konektag.activation_challenges c
SET expires_at = 'infinity'::timestamptz,
    status = CASE WHEN c.status = 'completed' THEN 'completed' ELSE 'active' END
WHERE c.campaign_id = (
      SELECT id
      FROM konektag.activation_campaigns
      WHERE internal_name = 'challenge-100-eur-summer-2026'
    );

COMMIT;
