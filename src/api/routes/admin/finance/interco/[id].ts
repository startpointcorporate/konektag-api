import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('interco:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const id = decodeURIComponent(params.id as string);
  try {
    const result = await financeReadRepository.getIntercompany(id);
    if (!result) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    const pos = result.position;

    return new Response(JSON.stringify({
      position: {
        ...pos,
        gross_position_amount: Number(pos.gross_position_amount || 0),
        source_k_quantity: Number(pos.source_k_quantity || 0),
        valuation_rate: pos.valuation_rate ? Number(pos.valuation_rate) : null,
      },
      klotSources: result.klotSources.map((s: any) => ({
        ...s,
        kQuantity: Number(s.kQuantity || 0),
        allocatedLocalAmount: Number(s.allocatedLocalAmount || 0),
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
