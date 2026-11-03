import type { RouteHandler } from '../../../http';
import { clearingService } from '../../../../application/services/clearing-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('clearing:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { request } = context;
  const url = new URL(request.url);
  try {
    const le = url.searchParams.get('legal_entity');
    const status = url.searchParams.get('status');
    const result = await clearingService.listBatches({ legalEntityId: le || undefined, status: status || undefined, limit: 30 });
    return new Response(JSON.stringify({ data: result.map(b => ({
      clearing_batch_id: b.batchRef,
      operation_id: b.id,
      legal_entity_a: b.legalEntityId,
      legal_entity_b: b.counterpartyEntityId,
      currency: b.currency,
      corridor: null,
      gross_receivable_a: null,
      gross_payable_a: null,
      net_position_a: b.netAmount,
      net_position_b: -b.netAmount,
      position_count: b.positionCount,
      exception_count: 0,
      status: b.status,
      period_from: b.periodStart,
      period_to: b.periodEnd,
      prepared_at: null,
      approved_at: null,
    })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
};
