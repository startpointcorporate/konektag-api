import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const onlyActive = url.searchParams.get('active') !== 'false';

    let query = `SELECT p.*, mp.business_name AS merchant_name, mp.slug AS merchant_slug
      FROM konektag.promotions p
      LEFT JOIN konektag.merchant_profiles mp ON mp.id = p.merchant_id`;
    const params: unknown[] = [];
    const conds: string[] = [];
    let idx = 1;

    if (onlyActive) { conds.push(`p.is_active = true AND (p.end_date IS NULL OR p.end_date > now())`); }
    if (category) { conds.push(`p.category = $${idx++}`); params.push(category); }

    if (conds.length) query += ' WHERE ' + conds.join(' AND ');
    query += ` ORDER BY p.created_at DESC LIMIT $${idx++}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);
    return new Response(JSON.stringify({ data: rows }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ data: [], error: err.message }), { status: 200 });
  }
};
