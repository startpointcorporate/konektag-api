import { resolveAnalyticsAccess } from '../../../../application/services/analytics-access.ts';
import { entitlementDecisionService, entitlementResponse } from '../../../../application/services/entitlement-decision-service.ts';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const period = url.searchParams.get('period') || '30d';
  const slug = url.searchParams.get('slug');
  const merchantProfileId = url.searchParams.get('merchantProfileId');

  const periodMap: Record<string, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
    '12m': '365 days',
  };
  const interval = periodMap[period] || '30 days';

  try {
    const access = await resolveAnalyticsAccess(user.id, slug, merchantProfileId);
    if (access.response) return access.response;
    const decision = await entitlementDecisionService.decide({ actorId: user.id, merchantId: access.profileId, capability: 'analytics.export' });
    if (!decision.allowed) return entitlementResponse(decision);
    const profileFilter = 'AND pa.profile_id = $2';
    const params: unknown[] = [interval, access.profileId];

    const { rows } = await pool.query(
      `SELECT DATE(created_at) AS date,
         COUNT(*) FILTER (WHERE event_type = 'view') AS vues,
         COUNT(*) FILTER (WHERE event_type = 'message_sent') AS messages,
         COUNT(*) FILTER (WHERE event_type = 'phone_click') AS appels,
         COUNT(*) FILTER (WHERE event_type = 'direction_click') AS itineraires
       FROM konektag.profile_analytics pa
       WHERE pa.created_at > NOW() - $1::INTERVAL ${profileFilter}
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      params,
    );

    const csv = 'Date,Vues,Messages,Appels,Itinéraires\n'
      + rows.map(r => [r.date, r.vues, r.messages, r.appels, r.itineraires].join(',')).join('\n');

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="konektag-analytics-${period}.csv"`,
      },
    });
  } catch (err) {
    console.error('[analytics/export]', err);
    return new Response('Error', { status: 500 });
  }
};
