import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });

    const keycloakId = user.keycloak_id;
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '10', 10) || 10));

    const userRes = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
    if (!userRes.rows.length) return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });

    const userId = userRes.rows[0].id;
    const { rows } = await pool.query(
      `SELECT b.id, b.merchant_profile_id AS merchant_id, b.customer_user_id AS user_id,
              b.state AS status, b.scheduled_at AS booking_date, b.note AS notes, b.created_at,
              mp.business_name AS merchant_name, mp.slug AS merchant_slug
       FROM konektag.core_transactions b
       JOIN konektag.merchant_profiles mp ON mp.id = b.merchant_profile_id
       WHERE b.customer_user_id = $1 AND b.kind = 'RESERVATION'
       ORDER BY b.created_at DESC LIMIT $2`,
      [userId, limit]
    );

    return new Response(JSON.stringify({ data: rows, total: rows.length }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });
  }
};
