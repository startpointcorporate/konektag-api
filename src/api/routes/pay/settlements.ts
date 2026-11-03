import type { RouteHandler } from '../../http';
import { settlementService } from '../../../application/services/settlement-service.ts';
import { merchantService } from '../../../application/merchant-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals, url }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const merchantProfileId = url.searchParams.get('merchantProfileId');
    if (!merchantProfileId) return Response.json({ error: 'merchantProfileId required' }, { status: 400 });
    try { await merchantService.requireOwnerOrManager(merchantProfileId, user.id); } catch { return Response.json({ error: 'MERCHANT_SCOPE_FORBIDDEN' }, { status: 403 }); }
    const result = await settlementService.listSettlements({ userId: user.id, merchantProfileId, limit: 50 });
    const settlements = result.map(s => ({
      name: s.settlementRef,
      settlement_id: s.settlementRef,
      operation_id: s.id,
      merchant: s.merchantProfileId,
      gross_amount: s.grossAmount,
      net_amount: s.netAmount,
      amount: s.netAmount,
      currency: s.currency,
      status: s.status,
      settlement_date: s.settlementDate,
      creation: s.createdAt,
    }));
    const { rows: [pending] } = await pool.query(`SELECT COALESCE(SUM(net_amount),0)::numeric AS available_balance, MIN(settlement_due_date) AS next_due_date FROM konektag.merchant_sales WHERE merchant_profile_id=$1 AND deleted_at IS NULL AND status IN ('CREATED','PARTIALLY_SETTLED')`, [merchantProfileId]);
    return Response.json({ settlements, summary: { availableBalance: Number(pending.available_balance || 0), nextDueDate: pending.next_due_date || null } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
