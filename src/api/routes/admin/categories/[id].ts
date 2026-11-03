import type { RequestContext } from '../../../http';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

async function isAdmin(locals: RequestContext['locals']): Promise<boolean> {
  if (!locals.user) return false;
  const { rows: [databaseUser] } = await pool.query('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return databaseUser?.role === 'admin';
}

export const GET: RouteHandler = async ({ params, locals }) => {
  if (!(await isAdmin(locals))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { id } = params;

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
       WHERE mc.id = $1
       GROUP BY mc.id, mc.code, mc.name_i18n, mc.description, mc.icon, mc.sort_order, mc.is_active, mc.created_at, mc.updated_at`,
      [id]
    );

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Category not found' }), { status: 404 });
    }

    return new Response(JSON.stringify(rows[0]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[admin/categories/id]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const PUT: RouteHandler = async ({ params, request, locals }) => {
  if (!(await isAdmin(locals))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { id } = params;

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
    // Vérifier que la catégorie existe
    const existing = await pool.query(
      'SELECT id FROM konektag.merchant_categories WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Category not found' }), { status: 404 });
    }

    // Vérifier l'unicité du code si changé
    const checkCode = await pool.query(
      'SELECT id FROM konektag.merchant_categories WHERE code = $1 AND id != $2',
      [code, id]
    );

    if (checkCode.rows.length > 0) {
      return new Response(JSON.stringify({ error: 'Code already exists' }), { status: 409 });
    }

    // Mise à jour de la catégorie
    await pool.query(
      `UPDATE konektag.merchant_categories
       SET code = $1, name_i18n = $2, description = $3, icon = $4, sort_order = $5, is_active = $6, updated_at = now()
       WHERE id = $7`,
      [code, JSON.stringify(name_i18n), description, icon, sort_order || 0, is_active !== false, id]
    );

    // Mise à jour des capacités
    if (capabilities !== undefined) {
      // Supprimer les capacités existantes pour cette catégorie
      await pool.query(
        'DELETE FROM konektag.merchant_category_capabilities WHERE category_id = $1',
        [id]
      );

      // Créer les nouvelles capacités
      if (Array.isArray(capabilities)) {
        for (const capability of capabilities) {
          if (capability === 'CATALOG' || capability === 'BOOKING') {
            await pool.query(
              `INSERT INTO konektag.merchant_category_capabilities
               (category_id, capability_key, is_enabled)
               VALUES ($1, $2, true)`,
              [id, capability.toLowerCase()]
            );
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[admin/categories/id]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const DELETE: RouteHandler = async ({ params, locals }) => {
  if (!(await isAdmin(locals))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { id } = params;

  try {
    // Vérifier que la catégorie existe
    const existing = await pool.query(
      'SELECT id FROM konektag.merchant_categories WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Category not found' }), { status: 404 });
    }

    // Ne pas supprimer physiquement, mais désactiver
    await pool.query(
      'UPDATE konektag.merchant_categories SET is_active = false WHERE id = $1',
      [id]
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[admin/categories/id]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};