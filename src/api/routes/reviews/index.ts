import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });

    const keycloakId = user.keycloak_id;
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '10');

    const userRes = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
    if (!userRes.rows.length) return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });

    const userId = userRes.rows[0].id;
    const { rows } = await pool.query(
      `SELECT r.*, mp.business_name AS merchant_name
       FROM konektag.reviews r
       LEFT JOIN konektag.merchant_profiles mp ON mp.id = r.merchant_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC LIMIT $2`,
      [userId, limit]
    );

    return new Response(JSON.stringify({ data: rows, total: rows.length }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });
  }
};
