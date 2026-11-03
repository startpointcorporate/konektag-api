import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;
  const section = url.searchParams.get('section') || 'dashboard';

  try {
    if (section === 'dashboard') {
      const { rows: [row] } = await pool.query(
        `SELECT layout, role FROM konektag.dashboard_config WHERE user_id = $1`,
        [userId],
      );
      return new Response(JSON.stringify({
        widgets: (row?.layout?.widgets || ['wallet', 'send_money', 'qr_scanner', 'history']),
        role: row?.role || 'personal',
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Unknown section' }), { status: 400 });
  } catch {
    return new Response(JSON.stringify({ widgets: ['wallet', 'send_money', 'qr_scanner', 'history'], role: 'personal' }), { status: 200 });
  }
};
