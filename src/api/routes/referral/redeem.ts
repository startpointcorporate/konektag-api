import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { referralService } from '../../../application/services/referral-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const keycloakId = user.keycloak_id;
  const { rows } = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
  if (!rows.length) return new Response(null, { status: 401 });

  const body = await request.json();
  if (!body.code) {
    return new Response(JSON.stringify({ error: 'Code requis' }), { status: 400 });
  }

  try {
    await referralService.applyCode(body.code, rows[0].id);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    const status = err.message === 'INVALID_CODE' ? 404
      : err.message === 'SELF_REFERRAL' ? 400
      : err.message === 'ALREADY_REDEEMED' ? 409
      : 500;
    return new Response(JSON.stringify({ error: err.message }), { status });
  }
};
