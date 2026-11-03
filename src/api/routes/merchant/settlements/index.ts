import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  try {
    const result = await settlementService.listSettlements({ userId: user.id, limit: 30 });
    return new Response(JSON.stringify({
      data: result.map(s => ({
        settlement_id: s.settlementRef,
        gross_amount: s.grossAmount,
        net_amount: s.netAmount,
        currency: s.currency,
        payment_channel: null,
        provider_reference: null,
        status: s.status,
        settlement_date: s.settlementDate,
        confirmed_at: s.confirmedAt,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
