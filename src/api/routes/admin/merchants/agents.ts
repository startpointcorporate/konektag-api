import type { RouteHandler } from '../../../http';
import { cardBatchService } from '../../../../application/services/card-batch-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return false;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return u?.role === 'admin';
}

export const GET: RouteHandler = async ({ locals }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const merchants = await cardBatchService.listAgentMerchants();
  return new Response(JSON.stringify({ merchants }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
