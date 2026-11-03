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
      `SELECT o.id, o.merchant_profile_id AS merchant_id, o.customer_user_id AS user_id,
              o.state AS status, o.total_minor AS amount_minor, o.currency, o.note AS description,
              o.created_at, mp.business_name AS merchant_name
       FROM konektag.core_transactions o
       JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id
       WHERE o.customer_user_id = $1 AND o.kind = 'ORDER'
       ORDER BY o.created_at DESC LIMIT $2`,
      [userId, limit]
    );

    return new Response(JSON.stringify({ data: rows, total: rows.length }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });
  }
};
