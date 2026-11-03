import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';
import { settlementService } from '../../../../../application/services/settlement-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('finance:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const entity = decodeURIComponent(params.entity as string);
  try {
    const [entityDoc, salesResult, positions, corridors] = await Promise.all([
      financeReadRepository.getLegalEntity(entity),
      financeReadRepository.listMerchantSales({ legalEntity: entity, limit: 50 }),
      financeReadRepository.getEntityFinancialPosition(entity),
      financeReadRepository.listActiveCorridors(),
    ]);
    const todaySales = salesResult.data;

    const settlements = await settlementService.listSettlements({ legalEntityId: entity, limit: 20 });

    const sales = (todaySales || []).map((s: any) => ({
      saleId: s.sale_id,
      grossAmount: Number(s.gross_amount || 0),
      commissionAmount: Number(s.commission_amount || 0),
      netPayable: Number(s.net_payable || 0),
      status: s.status,
      kQuantity: s.k_quantity,
      crossEntity: s.cross_entity,
      currency: s.currency,
      saleDate: s.sale_date,
      merchant: s.merchant,
    }));

    const todayCount = sales.filter((s: any) => s.status !== 'CANCELLED').length;
    const todayGross = sales.filter((s: any) => s.status !== 'CANCELLED')
      .reduce((sum: number, s: any) => sum + s.grossAmount, 0);
    const todayCommission = sales.filter((s: any) => s.status !== 'CANCELLED')
      .reduce((sum: number, s: any) => sum + s.commissionAmount, 0);
    const pendingSettlements = sales.filter((s: any) =>
      ['CONFIRMED', 'SETTLEMENT_PENDING'].includes(s.status));
    const blockedSales = sales.filter((s: any) =>
      ['BLOCKED', 'DISPUTED'].includes(s.status));
    const crossEntityCount = sales.filter((s: any) => s.crossEntity).length;

    const posData = positions?.[0];
    const networkReceivable = posData?.network_receivable != null ? Number(posData.network_receivable) : null;
    const networkPayable = posData?.network_payable != null ? Number(posData.network_payable) : null;
    const hasInterco = networkReceivable != null || networkPayable != null;

    return new Response(JSON.stringify({
      entity: entityDoc,
      kpis: {
        todaySalesCount: todayCount,
        todaySalesGross: todayGross,
        todayCommission,
        pendingSettlementsCount: pendingSettlements.length,
        pendingSettlementsTotal: pendingSettlements.reduce((s: number, x: any) => s + x.netPayable, 0),
        blockedCount: blockedSales.length,
        blockedAmount: blockedSales.reduce((s: number, x: any) => s + x.grossAmount, 0),
        crossEntityCount,
      },
      positions: {
        cashBalance: posData?.cash_balance != null ? Number(posData.cash_balance) : null,
        merchantPayable: posData?.merchant_payable != null ? Number(posData.merchant_payable) : null,
        networkReceivable,
        networkPayable,
        networkNet: posData?.network_net_position != null ? Number(posData.network_net_position) : null,
        hasInterco,
        calculatedAt: posData?.calculated_at || null,
      },
      corridors,
      recentSales: sales.slice(0, 15),
      settlements: settlements.map(s => ({
        name: s.settlementRef,
        establishment: s.merchantName || s.merchantProfileId,
        grossAmount: s.grossAmount,
        commissionAmount: s.commissionAmount,
        netAmount: s.netAmount,
        status: s.status,
        date: s.settlementDate,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
