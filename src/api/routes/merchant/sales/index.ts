import type { RouteHandler } from '../../../http';
import { financeReadRepository } from '../../../../infrastructure/repositories/finance-read-repository.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const url = new URL(request.url);
  const legalEntity = url.searchParams.get('legal_entity') || undefined;
  const status = url.searchParams.get('status') || undefined;
  const currency = url.searchParams.get('currency') || undefined;
  const corridor = url.searchParams.get('corridor') || undefined;
  const crossEntity = url.searchParams.get('cross_entity');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = 25;

  try {
    if (url.searchParams.get('summary') === '1') {
      const summary = await financeReadRepository.summarizeMerchantSales(locals.user.id);
      return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const result = await financeReadRepository.listMerchantSales({
      legalEntity: legalEntity && legalEntity !== 'all' ? legalEntity : undefined,
      status, currency, corridor, crossEntity: crossEntity === '1',
      merchantUserId: locals.user.id, page, limit,
    });

    return new Response(JSON.stringify({
      data: result.data.map((s: any) => ({
        ...s,
        gross_amount: Number(s.gross_amount || 0),
        commission_amount: Number(s.commission_amount || 0),
        net_payable: Number(s.net_payable || 0),
        k_quantity: Number(s.k_quantity || 0),
      })),
      total: result.total,
      page,
      pageSize: limit,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
