import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('klots:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const id = decodeURIComponent(params.id as string);
  try {
    const result = await financeReadRepository.getKlot(id);
    if (!result) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }

    return new Response(JSON.stringify({
      klot: {
        ...result.klot,
        initial_quantity: Number(result.klot.initial_quantity || 0),
        remaining_quantity: Number(result.klot.remaining_quantity || 0),
        k_send_depth: Number(result.klot.k_send_depth || 0),
      },
      movements: result.movements.map((m: any) => ({
        ...m,
        quantity: Number(m.quantity || 0),
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
