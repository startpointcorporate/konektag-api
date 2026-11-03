import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../../application/merchant-service.ts';

const ADMIN_CHECK = `SELECT role FROM konektag.users WHERE id = $1`;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(ADMIN_CHECK, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(null, { status: 403 });

  try {
    const claims = await merchantService.getPendingClaims();
    return new Response(JSON.stringify(claims), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[admin/merchants/claims]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(null, { status: 403 });

  try {
    const body = await request.json();
    const { claimId, action } = body;
    if (!claimId || !action) {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'claimId et action requis' }), { status: 400 });
    }

    if (action === 'approve') {
      await merchantService.approveClaim(claimId, admin.id);
    } else if (action === 'reject') {
      await merchantService.rejectClaim(claimId, admin.id);
    } else {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'action doit être approve ou reject' }), { status: 400 });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[admin/merchants/claims]', error);
    return new Response(JSON.stringify({ error: 'CLAIM_ERROR', message: error.message }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
