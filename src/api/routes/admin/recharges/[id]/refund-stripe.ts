import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { refundStripeRecharge } from '../../../../../application/commands/admin/refund-stripe-command.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return { ...user, dbId: u.id };
}

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  const rechargeName = decodeURIComponent(params.id as string);
  if (!rechargeName) {
    return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
  }

  const reason = (body.reason || '').trim();
  if (!reason) {
    return new Response(JSON.stringify({ error: 'MISSING_FIELD', field: 'reason' }), { status: 400 });
  }

  const amount = body.amount ? parseInt(String(body.amount), 10) : undefined;

  try {
    const result = await refundStripeRecharge({
      rechargeName,
      adminId: admin.dbId,
      reason,
      amount,
    });

    return new Response(JSON.stringify({
      success: true,
      rechargeName: result.rechargeName,
      stripeRefundId: result.stripeRefundId,
      message: result.previousStatus
        ? 'Recharge d\u00E9j\u00E0 rembours\u00E9e (idempotent)'
        : 'Remboursement Stripe effectu\u00E9 avec succ\u00E8s',
    }), { status: 200 });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    console.error(`[admin/recharges/refund-stripe] ${rechargeName}:`, err.message);
    return new Response(JSON.stringify({ error: err.message || 'SERVER_ERROR' }), { status: statusCode });
  }
};
