import type { RouteHandler } from '../../../http';
import { qrService } from '../../../../application/services/qr-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const qr = await qrService.getQR(params.name!);
    const { rows: [owned] } = await pool.query(
      `SELECT 1 FROM konektag.checkout_intents ci
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = ci.merchant_profile_id
       WHERE ci.public_id = $1 AND mm.user_id = $2 AND mm.status = 'active'
         AND mm.role IN ('owner', 'manager')`, [params.name, user.id]);
    if (!owned) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
    return new Response(JSON.stringify(qr), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
  }
};
