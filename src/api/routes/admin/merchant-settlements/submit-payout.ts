import type { RouteHandler } from '../../../http';
import { merchantSettlementPayoutService } from '../../../../application/services/merchant-settlement-payout-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('settlements:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  try {
    const body = await request.json();
    if (typeof body.settlementId !== 'string' || !['BANK', 'PSP', 'MOBILE_MONEY'].includes(body.rail)) return Response.json({ error: 'INVALID_MANUAL_PAYOUT' }, { status: 400 });
    return Response.json(await merchantSettlementPayoutService.startManualPayout({ settlementId: body.settlementId, makerId: guard.user!.id, rail: body.rail }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'SETTLEMENT_PAYOUT_FAILED' }, { status: 409 });
  }
};
