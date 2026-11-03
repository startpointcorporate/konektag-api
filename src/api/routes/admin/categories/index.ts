import type { RequestContext } from '../../../http';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

async function isAdmin(locals: RequestContext['locals']): Promise<boolean> {
  if (!locals.user) return false;
  const { rows: [databaseUser] } = await pool.query('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return databaseUser?.role === 'admin';
}

export const GET: RouteHandler = async ({ locals }) => {
  if (!(await isAdmin(locals))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
        mc.id,
        mc.code,
        mc.name_i18n,
        mc.description,
        mc.icon,
        mc.sort_order,
        mc.is_active,
        mc.created_at,
        mc.updated_at,
        ARRAY_AGG(
          CASE
            WHEN mcc.capability_key = 'catalog' AND mcc.is_enabled THEN 'CATALOG'
            WHEN mcc.capability_key = 'booking' AND mcc.is_enabled THEN 'BOOKING'
          END
        ) FILTER (WHERE mcc.capability_key IN ('catalog', 'booking')) AS capabilities
       FROM konektag.merchant_categories mc
       LEFT JOIN konektag.merchant_category_capabilities mcc ON mcc.category_id = mc.id
       GROUP BY mc.id, mc.code, mc.name_i18n, mc.description, mc.icon, mc.sort_order, mc.is_active, mc.created_at, mc.updated_at
       ORDER BY mc.sort_order, mc.created_at`
    );

    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[admin/categories]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!(await isAdmin(locals))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { code, name_i18n, description, icon, sort_order, is_active, capabilities } = body as any;

  // Validation des données
  if (!code || !name_i18n || typeof name_i18n !== 'object') {
    return new Response(JSON.stringify({ error: 'Invalid input data' }), { status: 400 });
  }

  try {
    // Vérifier l'unicité du code
    const existing = await pool.query(
      'SELECT id FROM konektag.merchant_categories WHERE code = $1',
      [code]
    );

    if (existing.rows.length > 0) {
      return new Response(JSON.stringify({ error: 'Code already exists' }), { status: 409 });
    }

    // Insertion de la catégorie
    const { rows } = await pool.query(
      `INSERT INTO konektag.merchant_categories
       (code, name_i18n, description, icon, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [code, JSON.stringify(name_i18n), description, icon, sort_order || 0, is_active !== false]
    );

    const categoryId = rows[0].id;

    // Création des capacités
    if (capabilities && Array.isArray(capabilities)) {
      for (const capability of capabilities) {
        if (capability === 'CATALOG' || capability === 'BOOKING') {
          await pool.query(
            `INSERT INTO konektag.merchant_category_capabilities
             (category_id, capability_key, is_enabled)
             VALUES ($1, $2, true)`,
            [categoryId, capability.toLowerCase()]
          );
        }
      }
    }

    return new Response(JSON.stringify({ id: categoryId }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[admin/categories]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};