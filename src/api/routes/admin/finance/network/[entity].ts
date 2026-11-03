import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('finance:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const entity = decodeURIComponent(params.entity as string);
  try {
    const result = await financeReadRepository.getNetworkPosition(entity);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
