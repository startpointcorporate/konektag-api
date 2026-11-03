import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

async function centralAccess(locals: unknown) {
  const access = await requireBackofficePermission('merchants:write')(locals);
  return access.authorized && access.user?.role === 'admin' ? null : forbiddenResponse(access.reason);
}

export const GET: RouteHandler = async ({ url, locals }) => {
  const denied = await centralAccess(locals);
  if (denied) return denied;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const { rows: subscriptions } = await pool.query(`SELECT s.*, mp.business_name AS merchant_name,
    CASE WHEN s.status='ACTIVE' AND s.subscription_end<=CURRENT_DATE THEN 'EXPIRED' ELSE s.status END AS effective_status
    FROM konektag.merchant_pro_subscriptions s
    JOIN konektag.merchant_profiles mp ON mp.id=s.merchant_profile_id
    ORDER BY s.created_at DESC,s.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  const { rows: [count] } = await pool.query('SELECT count(*)::int AS total FROM konektag.merchant_pro_subscriptions');
  const total = count.total;
  return Response.json({ subscriptions, total });
};

export const POST: RouteHandler = async ({ locals }) => {
  const denied = await centralAccess(locals);
  if (denied) return denied;
  return Response.json({ error: 'USE_MERCHANT_PRO_ACTIVATION' }, { status: 405 });
};
