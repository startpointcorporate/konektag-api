import type { RouteHandler } from '../../../http';
import { financeReadRepository } from '../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('sales:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const id = decodeURIComponent(params.id as string);
  try {
    const result = await financeReadRepository.getMerchantSale(id);
    if (!result) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }

    const sale = result.sale;

    return new Response(JSON.stringify({
      sale: {
        ...sale,
        gross_amount: Number(sale.gross_amount || 0),
        commission_amount: Number(sale.commission_amount || 0),
        commission_rate: Number(sale.commission_rate || 0),
        bonus_amount: Number(sale.bonus_amount || 0),
        other_fee_amount: Number(sale.other_fee_amount || 0),
        net_payable: Number(sale.net_payable || 0),
        k_quantity: Number(sale.k_quantity || 0),
      },
      klotAllocations: result.klotAllocations.map((a: any) => ({
        klotId: a.klotId,
        quantity: Number(a.quantity || 0),
        sequence: a.sequence,
        originLegalEntity: a.originLegalEntity,
        originCurrency: a.originCurrency,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
