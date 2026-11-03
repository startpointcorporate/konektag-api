import type { RouteHandler } from '../../../http';
import { financeReadRepository } from '../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('finance:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  try {
    const entities = await financeReadRepository.listLegalEntities();
    return new Response(JSON.stringify(entities), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
