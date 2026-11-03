import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { adminRechargeDetailQuery } from '../../../../application/queries/admin/recharges/detail.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, params }) => {
  if (!await adminGuard(locals)) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  const rechargeId = params.id as string;
  if (!rechargeId) {
    return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });
  }

  try {
    const detail = await adminRechargeDetailQuery.getById(decodeURIComponent(rechargeId));
    if (!detail) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }

    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[admin/recharges/detail]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
