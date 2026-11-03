import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ url }) => {
  const categoryId = url.searchParams.get('categoryId');
  if (!categoryId) {
    return new Response(JSON.stringify({ error: 'CATEGORY_ID_REQUIRED' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.category_id, s.code, s.name_i18n, s.sort_order
       FROM konektag.offer_subcategories s
       JOIN konektag.offer_categories c ON c.id = s.category_id
      WHERE s.category_id = $1
        AND s.is_active = true AND s.deleted_at IS NULL
        AND c.is_active = true AND c.deleted_at IS NULL
      ORDER BY s.sort_order, s.code`,
    [categoryId],
  );

  return new Response(JSON.stringify({ subcategories: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
