import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  let client: PoolClient | undefined;
  try {
    const body = await request.json();
    const { slug, eventType, linkId, sessionId, shareId, activityCode, channel, source, campaign } = body;
    const allowedEvents = ['view','phone_click','direction_click','message_sent','external_link_click','menu_view','catalog_view' ,'reservation_click','share','share_return'];
    if (!slug || !eventType || !allowedEvents.includes(eventType)) {
      return new Response(null, { status: 204 });
    }

    if (eventType === 'share_return' && (!(typeof sessionId === 'string' && sessionId.length > 0) || !(typeof shareId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shareId)))) return new Response(null,{status:204});
    const { rows: [mp] } = await pool.query(
      `SELECT id, user_id FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    if (!mp) return new Response(null, { status: 204 });
    if (/bot|crawler|spider|preview/i.test(request.headers.get('user-agent') || '')) return new Response(null, { status: 204 });
    if (locals.user) {
      if (mp.user_id === locals.user.id) return new Response(null, { status: 204 });
      const { rows: [member] } = await pool.query(`SELECT 1 FROM konektag.merchant_memberships WHERE merchant_profile_id=$1 AND user_id=$2 AND status='active' AND removed_at IS NULL LIMIT 1`, [mp.id, locals.user.id]);
      if (member) return new Response(null, { status: 204 });
    }
    let externalLink: any = null;
    if (eventType === 'external_link_click') {
      if (!linkId) return new Response(null, { status: 204 });
      const { rows: [link] } = await pool.query(
        `SELECT id, label, link_type FROM konektag.merchant_external_links WHERE id=$1 AND merchant_profile_id=$2`,
        [linkId, mp.id],
      );
      if (!link) return new Response(null, { status: 204 });
      externalLink = link;
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || null;
    const userAgent = request.headers.get('user-agent') || null;

    // Serialize read/insert across processes and tabs without schema changes.
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([mp.id, eventType, typeof sessionId === 'string' ? sessionId.slice(0,80) : ip, externalLink?.id || null])]);
    // Returns are deduplicated for the lifetime of the attributed session.
    const { rows: [recent] } = await client.query(
      `SELECT id FROM konektag.profile_analytics
       WHERE profile_id = $1 AND event_type = $2 AND (session_id = $7::varchar OR ($7::varchar IS NULL AND ip_address IS NOT DISTINCT FROM $3::text))
       AND external_link_id IS NOT DISTINCT FROM $4::uuid
       AND activity_code IS NOT DISTINCT FROM $5::varchar
       AND share_id IS NOT DISTINCT FROM $6::uuid
       AND session_id IS NOT DISTINCT FROM $7::varchar
       AND ($2 = 'share_return' OR created_at > NOW() - INTERVAL '5 minutes') LIMIT 1`,
      [mp.id, eventType, ip, externalLink?.id || null,
       ['Restaurant','Hotel','Commerce'].includes(activityCode) ? activityCode : null,
       typeof shareId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shareId) ? shareId : null,
       typeof sessionId === 'string' ? sessionId.slice(0,80) : null],
    );
    if (recent) { await client.query('COMMIT'); return new Response(null, { status: 204 }); }

    const safeShareId = typeof shareId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shareId) ? shareId : null;
    const metadata = { ...(externalLink ? { label: externalLink.label, linkType: externalLink.link_type } : {}), channel: channel || null, source: source || null, campaign: campaign || null };
    await client.query(
      `INSERT INTO konektag.profile_analytics
       (profile_id,event_type,ip_address,user_agent,external_link_id,event_metadata,session_id,share_id,activity_code,channel,source,campaign)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [mp.id,eventType,ip,userAgent,externalLink?.id||null,metadata,
       typeof sessionId==='string'?sessionId.slice(0,80):null,safeShareId,
       ['Restaurant','Hotel','Commerce'].includes(activityCode)?activityCode:null,
       typeof channel==='string'?channel.slice(0,40):null,typeof source==='string'?source.slice(0,60):null,
       typeof campaign==='string'?campaign.slice(0,100):null],
    );

    await client.query('COMMIT');
    return new Response(null, { status: 204 });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[analytics/track]', err);
    return new Response(null, { status: 204 });
  } finally { client?.release(); }
};
