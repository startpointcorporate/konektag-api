import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;

  try {
    const { rows: [row] } = await pool.query(
      `SELECT layout, role FROM konektag.dashboard_config WHERE user_id = $1`,
      [userId],
    );
    return new Response(JSON.stringify({
      layout: row?.layout || { widgets: [] },
      role: row?.role || 'personal',
    }), { status: 200 });
  } catch {
    return new Response(JSON.stringify({ layout: { widgets: [] }, role: 'personal' }), { status: 200 });
  }
};

export const PUT: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;

  try {
    const body = await request.json();
    await pool.query(
      `INSERT INTO konektag.dashboard_config (user_id, layout, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET layout = $2, updated_at = now()`,
      [userId, JSON.stringify(body.layout || { widgets: [] })],
    );
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
