import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  try {
    const { rows } = await pool.query(
      `SELECT fm.id, fm.created_at,
              mp.id as merchant_id, mp.business_name, mp.slug,
              mp.short_description, mp.city, mp.country, mp.cover_image_url, mp.logo_url,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN rp.merchant_profile_id IS NOT NULL THEN 'Restaurant' END,
                CASE WHEN hp.merchant_profile_id IS NOT NULL THEN 'Hotel' END,
                CASE WHEN cp.merchant_profile_id IS NOT NULL THEN 'Commerce' END
              ], NULL) AS activity_codes
       FROM konektag.favorite_merchants fm
       JOIN konektag.merchant_profiles mp ON mp.id = fm.merchant_profile_id
       LEFT JOIN konektag.restaurant_profiles rp
         ON rp.merchant_profile_id = mp.id AND rp.deleted_at IS NULL
       LEFT JOIN konektag.hotel_profiles hp
         ON hp.merchant_profile_id = mp.id AND hp.deleted_at IS NULL
       LEFT JOIN konektag.commerce_profiles cp
         ON cp.merchant_profile_id = mp.id AND cp.deleted_at IS NULL
       WHERE fm.user_id = $1 AND mp.deleted_at IS NULL
       ORDER BY fm.created_at DESC`,
      [user.keycloak_id]
    );
    return new Response(JSON.stringify(rows), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  try {
    const body = await request.json();
    const { merchantProfileId } = body;
    if (!merchantProfileId) {
      return new Response(JSON.stringify({ error: 'merchantProfileId requis' }), { status: 400 });
    }

    const { rows } = await pool.query(
      `INSERT INTO konektag.favorite_merchants (user_id, merchant_profile_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, merchant_profile_id) DO NOTHING
       RETURNING id`,
      [user.keycloak_id, merchantProfileId]
    );

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Déjà dans vos favoris' }), { status: 409 });
    }

    return new Response(JSON.stringify({ success: true, id: rows[0].id }), { status: 201 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const DELETE: RouteHandler = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  try {
    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'Paramètre id requis' }), { status: 400 });

    const { rowCount } = await pool.query(
      `DELETE FROM konektag.favorite_merchants WHERE id = $1 AND user_id = $2`,
      [id, user.keycloak_id]
    );

    if (rowCount === 0) {
      return new Response(JSON.stringify({ error: 'Favori introuvable' }), { status: 404 });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
