import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('settlements:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    const result = await settlementService.prepareSettlement({
      settlementRef: body.settlementRef || `STL-${Date.now()}`,
      legalEntityId: body.legalEntityId,
      merchantProfileId: body.merchantProfileId,
      merchantSaleIds: body.merchantSaleIds || [],
      grossAmount: body.grossAmount,
      netAmount: body.netAmount,
      currency: body.currency,
      rail: body.rail || 'mobile_money',
      railProofRef: body.railProofRef,
      railProofUrl: body.railProofUrl,
      valueDate: body.valueDate || new Date().toISOString().slice(0, 10),
      preparedBy: guard.user!.id,
      notes: body.notes,
    });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
