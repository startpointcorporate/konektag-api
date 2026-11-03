import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  try {
    const { rows } = await pool.query(
      `SELECT fu.id, fu.favorite_user_id AS user_id, fu.created_at,
              u.username, u.keycloak_id,
              COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name
       FROM konektag.favorite_users fu
       JOIN konektag.users u ON u.id = fu.favorite_user_id
       WHERE fu.user_id = $1
       ORDER BY fu.created_at DESC`, [user.keycloak_id]);
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  try {
    const { userId } = await request.json();
    if (!userId) return new Response(JSON.stringify({ error: 'userId requis' }), { status: 400 });
    const { rows: target } = await pool.query(`SELECT u.id,u.keycloak_id FROM konektag.users u JOIN konektag.user_public_profiles upp ON upp.user_id=u.id AND upp.status='published' WHERE u.id=$1`, [userId]);
    if (!target[0]) return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), { status: 404 });
    if (target[0].keycloak_id === user.keycloak_id) return new Response(JSON.stringify({ error: 'CANNOT_FAVORITE_SELF' }), { status: 400 });
    const { rows } = await pool.query(
      `INSERT INTO konektag.favorite_users(user_id,favorite_user_id) VALUES($1,$2)
       ON CONFLICT(user_id,favorite_user_id) DO NOTHING RETURNING id`, [user.keycloak_id,userId]);
    return new Response(JSON.stringify({ success:true, id:rows[0]?.id ?? null, alreadyFavorite:rows.length===0 }), { status: rows.length ? 201 : 200, headers:{'Content-Type':'application/json'} });
  } catch (err:any) { return new Response(JSON.stringify({ error:err.message }), { status:500 }); }
};

export const DELETE: RouteHandler = async ({ url, locals }) => {
  const user=locals.user;
  if(!user) return new Response(JSON.stringify({error:'UNAUTHORIZED'}),{status:401});
  const id=url.searchParams.get('id');
  if(!id) return new Response(JSON.stringify({error:'Paramètre id requis'}),{status:400});
  const {rowCount}=await pool.query('DELETE FROM konektag.favorite_users WHERE id=$1 AND user_id=$2',[id,user.keycloak_id]);
  return new Response(JSON.stringify({success:(rowCount??0)>0}),{status:rowCount?200:404,headers:{'Content-Type':'application/json'}});
};
