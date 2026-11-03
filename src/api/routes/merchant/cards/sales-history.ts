import type { RouteHandler } from '../../../http';
import { cardBatchService } from '../../../../application/services/card-batch-service.ts';

export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;

  const history = await cardBatchService.getMerchantSalesHistory(user.id, from, to);
  return new Response(JSON.stringify(history), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
