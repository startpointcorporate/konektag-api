import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

const activities = new Set(['Restaurant', 'Hotel', 'Commerce']);

export const GET: RouteHandler = async ({ url }) => {
  const activityCode = url.searchParams.get('activityCode');
  if (!activityCode || !activities.has(activityCode)) {
    return new Response(JSON.stringify({ error: 'INVALID_ACTIVITY_CODE' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  const { rows } = await pool.query(
    `SELECT id, code, activity_code, name_i18n, sort_order
       FROM konektag.offer_categories
      WHERE activity_code = $1 AND is_active = true AND deleted_at IS NULL
      ORDER BY sort_order, code`,
    [activityCode],
  );

  return new Response(JSON.stringify({ categories: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
