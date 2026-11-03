import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int as count, COALESCE(SUM(amount), 0)::int as total_amount
     FROM konektag.cards
     WHERE sold_by = $1 AND status = 'SOLD' AND sold_at::date = CURRENT_DATE AND deleted_at IS NULL`,
    [user.id],
  );
  return new Response(JSON.stringify(rows[0] || { count: 0, total_amount: 0 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
