import type { RouteHandler } from '../../../http';
import { resolveAnalyticsAccess } from '../../../../application/services/analytics-access.ts';
import { requireEntitlement } from '../../../../application/services/entitlement-decision-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const url = new URL(request.url);
  const access = await resolveAnalyticsAccess(locals.user.id, url.searchParams.get('slug'));
  if (access.response) return access.response;
  try {
    await requireEntitlement(locals.user.id, access.profileId, 'analytics.essential');
    const period = url.searchParams.get('period') === '7d' ? '7 days' : url.searchParams.get('period') === '90d' ? '90 days' : '30 days';
    const { rows } = await pool.query(
      `SELECT event_type, COUNT(*)::int AS count
       FROM konektag.growth_events
       WHERE merchant_profile_id = $1 AND occurred_at > now() - $2::interval
       GROUP BY event_type ORDER BY event_type`, [access.profileId, period]);
    return new Response(JSON.stringify({ period, events: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: error.status ?? 500, headers: { 'Content-Type': 'application/json' } });
  }
};
