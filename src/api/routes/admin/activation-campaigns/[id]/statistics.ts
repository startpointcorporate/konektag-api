import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';

async function adminGuard(locals: any) {
  const user = locals.user;
  if (!user) return null;
  const { rows } = await pool.query<{ role: string }>(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return rows[0]?.role === 'admin' ? user : null;
}

export const GET: RouteHandler = async ({ locals, params }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const campaignId = params.id;
  const [summary, milestones, countries] = await Promise.all([
    pool.query(
      `SELECT COUNT(ch.id)::int AS participants,
              COUNT(ch.id) FILTER (WHERE ch.status = 'active')::int AS active_challenges,
              COUNT(ch.id) FILTER (WHERE ch.status = 'completed')::int AS completed_challenges,
              COALESCE(SUM(b.amount) FILTER (WHERE b.status = 'credited'), 0)::bigint AS bonuses_credited,
              COUNT(b.id) FILTER (WHERE b.status = 'reconciliation_required')::int AS reconciliation_required
       FROM konektag.activation_campaigns c
       LEFT JOIN konektag.activation_challenges ch ON ch.campaign_id = c.id
       LEFT JOIN konektag.activation_bonuses b ON b.challenge_id = ch.id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [campaignId],
    ),
    pool.query(
      `SELECT m.id, m.public_title, m.metric_type, m.target_amount, m.bonus_amount,
              COUNT(p.id) FILTER (WHERE p.reached_at IS NOT NULL)::int AS reached_count,
              COUNT(b.id) FILTER (WHERE b.status = 'credited')::int AS credited_count
       FROM konektag.activation_milestones m
       LEFT JOIN konektag.activation_milestone_progress p ON p.milestone_id = m.id
       LEFT JOIN konektag.activation_bonuses b ON b.milestone_id = m.id
       WHERE m.campaign_id = $1
       GROUP BY m.id ORDER BY m.sort_order`,
      [campaignId],
    ),
    pool.query(
      `SELECT COALESCE(a.country_code, 'UNKNOWN') AS country_code,
              COUNT(*)::int AS activity_count,
              COALESCE(SUM(a.campaign_amount), 0) AS activity_volume_eur
       FROM konektag.activation_activity_events a
       JOIN konektag.activation_challenges ch ON ch.user_id = a.user_id
         AND a.occurred_at >= ch.started_at AND a.occurred_at <= ch.expires_at
       WHERE ch.campaign_id = $1
       GROUP BY COALESCE(a.country_code, 'UNKNOWN')
       ORDER BY activity_count DESC`,
      [campaignId],
    ),
  ]);
  if (!summary.rows[0]?.participants && !milestones.rows.length) {
    const exists = await pool.query(`SELECT 1 FROM konektag.activation_campaigns WHERE id = $1 AND deleted_at IS NULL`, [campaignId]);
    if (!exists.rows[0]) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
  }
  return new Response(JSON.stringify({ summary: summary.rows[0], milestones: milestones.rows, countries: countries.rows }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
