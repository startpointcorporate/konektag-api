import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async () => {
  const { rows } = await pool.query(
    `SELECT c.id, c.public_title, c.public_description, c.baseline, c.starts_at, c.ends_at,
            c.time_zone, c.currency, c.max_bonus_amount, c.eligible_country_codes,
            COALESCE(SUM(m.bonus_amount) FILTER (WHERE m.id IS NOT NULL), 0)::bigint AS total_bonus_amount,
            COALESCE(json_agg(json_build_object(
              'id', m.id, 'metricType', m.metric_type, 'targetAmount', m.target_amount,
              'bonusAmount', m.bonus_amount, 'title', m.public_title,
              'description', m.public_description, 'ctaType', m.cta_type,
              'eligibleCountryCodes', m.eligible_country_codes
            ) ORDER BY m.sort_order) FILTER (WHERE m.id IS NOT NULL), '[]') AS milestones
     FROM konektag.activation_campaigns c
     LEFT JOIN konektag.activation_milestones m ON m.campaign_id = c.id AND m.is_enabled
     WHERE c.status = 'active' AND c.deleted_at IS NULL AND c.starts_at <= now()
     GROUP BY c.id
     LIMIT 1`,
  );
  return new Response(JSON.stringify({ campaign: rows[0] ?? null }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
