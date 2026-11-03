import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('klots:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { request } = context;
  const url = new URL(request.url);
  const search = url.searchParams.get('q') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = 25;

  try {
    const result = await financeReadRepository.listKlots(search, page, limit);
    return new Response(JSON.stringify({
      data: result.data,
      total: result.total,
      page,
      pageSize: limit,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
