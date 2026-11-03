import { resolveAnalyticsAccess } from '../../../../application/services/analytics-access.ts';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401, headers:{'Cache-Control':'no-store'} });

  const url = new URL(request.url);
  const period = url.searchParams.get('period') ?? '30d';
  const slug = url.searchParams.get('slug');
  const merchantProfileId = url.searchParams.get('merchantProfileId');

  try {
    const access = await resolveAnalyticsAccess(user.id, slug, merchantProfileId);
    if (access.response) return access.response;
    const profileFilter = 'AND pa.profile_id = $2';

    const periodMap: Record<string, string> = {
      '7d': '7 days',
      '30d': '30 days',
      '90d': '90 days',
      '12m': '365 days',
    };
    if (!Object.prototype.hasOwnProperty.call(periodMap,period)) return new Response(JSON.stringify({error:'INVALID_PERIOD'}),{status:400,headers:{'Cache-Control':'no-store'}});
    const interval = periodMap[period];

    // Fixed-duration UTC windows, shared by every query in this response.
    const reference = new Date();
    const params: unknown[] = [String(Number(interval.split(' ')[0]) * 24) + ' hours', access.profileId, reference];

    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END), 0) AS views,
         COALESCE(SUM(CASE WHEN event_type = 'message_sent' THEN 1 ELSE 0 END), 0) AS messages,
         COALESCE(SUM(CASE WHEN event_type = 'phone_click' THEN 1 ELSE 0 END), 0) AS phone_clicks,
         COALESCE(SUM(CASE WHEN event_type = 'direction_click' THEN 1 ELSE 0 END), 0) AS direction_clicks
       FROM konektag.profile_analytics pa
       WHERE pa.created_at >= $3::timestamptz - $1::INTERVAL AND pa.created_at < $3::timestamptz ${profileFilter}`,
      params,
    );

    const stats = rows[0] || { views: 0, messages: 0, phone_clicks: 0, direction_clicks: 0 };

    // Daily breakdown
    const { rows: daily } = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'UTC') AS date,
         COUNT(*) FILTER (WHERE event_type = 'view') AS views,
         COUNT(*) FILTER (WHERE event_type = 'message_sent') AS messages,
         COUNT(*) FILTER (WHERE event_type = 'phone_click') AS phone_clicks,
         COUNT(*) FILTER (WHERE event_type = 'direction_click') AS direction_clicks
       FROM konektag.profile_analytics pa
       WHERE pa.created_at >= $3::timestamptz - $1::INTERVAL AND pa.created_at < $3::timestamptz ${profileFilter}
       GROUP BY DATE(created_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      params,
    );

    // Previous period for trend calculation
    const { rows: [prev] } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END), 0) AS views
       FROM konektag.profile_analytics pa
       WHERE pa.created_at >= $3::timestamptz - $1::INTERVAL * 2 AND pa.created_at < $3::timestamptz - $1::INTERVAL ${profileFilter}`,
      params,
    );

    const { rows: linkClicks } = await pool.query(
      `SELECT mel.id, mel.label, mel.url, mel.link_type,
              COUNT(pa.id)::int AS clicks
       FROM konektag.merchant_external_links mel
       LEFT JOIN konektag.profile_analytics pa
         ON pa.external_link_id = mel.id
        AND pa.profile_id = $2
        AND pa.event_type = 'external_link_click'
        AND pa.created_at >= $3::timestamptz - $1::INTERVAL AND pa.created_at < $3::timestamptz
       WHERE mel.merchant_profile_id = $2
       GROUP BY mel.id, mel.label, mel.url, mel.link_type
       ORDER BY clicks DESC, mel.display_order ASC, mel.label ASC`,
      params,
    );
    const socialTypes = new Set(['Instagram','Facebook','TikTok','YouTube','LinkedIn','Pinterest','X','Threads','Snapchat','WhatsApp','Telegram']);
    const links = linkClicks.map((row: any) => ({ ...row, clicks: Number(row.clicks) || 0, isSocial: socialTypes.has(row.link_type) }));
    const externalLinkClicks = links.reduce((sum: number, row: any) => sum + row.clicks, 0);
    const topLink = links.find((row: any) => row.clicks > 0) || null;
    const social = links.filter((row: any) => row.isSocial);
    const topSocial = social.find((row: any) => row.clicks > 0) || null;

    const { rows: shareChannels } = await pool.query(
      `SELECT COALESCE(channel,'unknown') AS channel,
              COUNT(*) FILTER (WHERE event_type='share')::int AS shares,
              COUNT(*) FILTER (WHERE event_type='share_return')::int AS returns
         FROM konektag.profile_analytics pa
        WHERE pa.created_at >= $3::timestamptz - $1::INTERVAL AND pa.created_at < $3::timestamptz AND pa.profile_id = $2
          AND pa.event_type IN ('share','share_return')
        GROUP BY COALESCE(channel,'unknown')
        ORDER BY shares DESC, returns DESC`, params);
    const sharesTotal = shareChannels.reduce((s:number,r:any)=>s+Number(r.shares||0),0);
    const returnsTotal = shareChannels.reduce((s:number,r:any)=>s+Number(r.returns||0),0);
    const shareItems = shareChannels.map((r:any)=>({channel:r.channel,shares:Number(r.shares)||0,returns:Number(r.returns)||0,returnRate:Number(r.shares)?Math.round(Number(r.returns)*100/Number(r.shares)):0}));
    const { rows: [journey] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE event_type='menu_view')::int AS menu_views,
              COUNT(*) FILTER (WHERE event_type='catalog_view')::int AS catalog_views,
              COUNT(*) FILTER (WHERE event_type='phone_click')::int AS phone_clicks,
              COUNT(*) FILTER (WHERE event_type='direction_click')::int AS direction_clicks,
              COUNT(*) FILTER (WHERE event_type='reservation_click')::int AS reservation_clicks,
              COUNT(*) FILTER (WHERE event_type='external_link_click')::int AS external_link_clicks
         FROM konektag.profile_analytics
        WHERE profile_id=$2 AND created_at >= $3::timestamptz - $1::INTERVAL AND created_at < $3::timestamptz
          AND (source='merchant_share' OR share_id IS NOT NULL)`,params);


    const prevViews = parseInt(prev?.views || '0', 10);
    const currentViews = Number(stats.views) || 0;
    const trend = prevViews > 0 ? Math.round(((currentViews - prevViews) / prevViews) * 100) : null;

    return new Response(JSON.stringify({
      views: { total: currentViews, previousTotal:prevViews, trend: trend === null ? null : trend > 0 ? `+${trend}%` : trend < 0 ? `${trend}%` : '0%' },
      messages: { total: Number(stats.messages) || 0, trend: null },
      phoneClicks: { total: Number(stats.phone_clicks) || 0, trend: null },
      directionClicks: { total: Number(stats.direction_clicks) || 0, trend: null },
      externalLinks: { totalClicks: externalLinkClicks, topLink, topSocial, items: links },
      sharing: { shares: sharesTotal, returns: returnsTotal, returnRate: sharesTotal ? Math.round(returnsTotal*100/sharesTotal) : 0, items: shareItems },
      socialJourney: { menuViews:Number(journey?.menu_views)||0, catalogViews:Number(journey?.catalog_views)||0, phoneClicks:Number(journey?.phone_clicks)||0, directionClicks:Number(journey?.direction_clicks)||0, reservationClicks:Number(journey?.reservation_clicks)||0, externalLinkClicks:Number(journey?.external_link_clicks)||0 },
      daily,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control':'no-store' },
    });
  } catch (err) {
    console.error('[analytics/stats]', err);
    return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), { status: 500, headers:{'Cache-Control':'no-store'} });
  }
};
