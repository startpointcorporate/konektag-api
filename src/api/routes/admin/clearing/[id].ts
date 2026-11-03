import type { RouteHandler } from '../../../http';
import { clearingService } from '../../../../application/services/clearing-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('clearing:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const id = decodeURIComponent(params.id as string);
  try {
    const b = await clearingService.getBatch(id);
    if (!b) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify({ batch: {
      clearing_batch_id: b.batchRef,
      operation_id: b.id,
      legal_entity_a: b.legalEntityId,
      legal_entity_b: b.counterpartyEntityId,
      currency: b.currency,
      corridor: null,
      gross_receivable_a: null,
      gross_payable_a: null,
      net_position_a: b.netAmount,
      gross_receivable_b: null,
      gross_payable_b: null,
      net_position_b: -b.netAmount,
      position_count: b.positionCount,
      exception_count: 0,
      status: b.status,
      period_from: b.periodStart,
      period_to: b.periodEnd,
      prepared_by: b.initiatedBy,
      prepared_at: null,
      approved_by: [b.financeA, b.financeB, b.compliance].filter(Boolean),
      approved_at: null,
      positions: (b.positions || []).map(p => ({
        position_id: p.positionId,
        creditor: p.direction === 'A_TO_B' ? p.legalEntityBId : p.legalEntityAId,
        debtor: p.direction === 'A_TO_B' ? p.legalEntityAId : p.legalEntityBId,
        amount: p.amount,
      })),
    }}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
};
