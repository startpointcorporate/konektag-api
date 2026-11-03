import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { referralService } from '../../../application/services/referral-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const keycloakId = user.keycloak_id;
  const { rows } = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
  if (!rows.length) return new Response(null, { status: 401 });

  const stats = await referralService.getStats(rows[0].id);
  return new Response(JSON.stringify(stats), { status: 200 });
};
