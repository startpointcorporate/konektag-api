import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ url }) => {
  const username = url.searchParams.get('username');
  if (!username || username.length < 3) {
    return new Response(
      JSON.stringify({ available: false, reason: 'too_short' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { rows } = await pool.query(
    `SELECT 1 FROM konektag.users WHERE username = $1 AND deleted_at IS NULL`,
    [username.toLowerCase()],
  );

  return new Response(
    JSON.stringify({ available: rows.length === 0 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
