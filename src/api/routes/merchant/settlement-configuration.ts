import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { merchantService } from '../../../application/merchant-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

const Body = z.object({ provider_account_id: z.string().uuid() }).strict();

export const GET: RouteHandler = async ({ locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  try {
    const merchant = await merchantService.getProfile(locals.user.id);
    const { rows } = await pool.query(`SELECT c.provider_account_id,a.display_name,a.payment_method,a.environment,a.connection_status,a.enabled FROM konektag.merchant_settlement_configurations c JOIN konektag.merchant_payment_provider_accounts a ON a.id=c.provider_account_id WHERE c.merchant_profile_id=$1`, [merchant.id]);
    return Response.json(rows[0] ?? null);
  } catch { return Response.json({ error: 'SERVER_ERROR' }, { status: 500 }); }
};

export const PUT: RouteHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'INVALID_REQUEST' }, { status: 422 });
  try {
    const merchant = await merchantService.getProfile(locals.user.id);
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM konektag.merchant_payment_provider_accounts WHERE id=$1 AND merchant_profile_id=$2 AND enabled AND connection_status='CONNECTED'`, [parsed.data.provider_account_id, merchant.id]);
    if (!rows[0]) return Response.json({ error: 'SETTLEMENT_ACCOUNT_UNAVAILABLE' }, { status: 422 });
    await pool.query(`INSERT INTO konektag.merchant_settlement_configurations(merchant_profile_id,provider_account_id) VALUES($1,$2) ON CONFLICT(merchant_profile_id) DO UPDATE SET provider_account_id=EXCLUDED.provider_account_id,updated_at=now(),version=konektag.merchant_settlement_configurations.version+1`, [merchant.id, rows[0].id]);
    return Response.json({ provider_account_id: rows[0].id });
  } catch { return Response.json({ error: 'SERVER_ERROR' }, { status: 500 }); }
};
