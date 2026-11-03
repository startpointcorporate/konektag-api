import type { RouteHandler } from '../../../http';
import { merchantSettlementPayoutService } from '../../../../application/services/merchant-settlement-payout-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('settlements:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  try {
    const body = await request.json();
    if (typeof body.payoutId !== 'string' || typeof body.approved !== 'boolean') return Response.json({ error: 'INVALID_PROOF_VERIFICATION' }, { status: 400 });
    return Response.json(await merchantSettlementPayoutService.verifyManualProof({ payoutId: body.payoutId, verifierId: guard.user!.id, approved: body.approved, rejectionReason: body.rejectionReason }));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'SETTLEMENT_PROOF_VERIFICATION_FAILED' }, { status: 409 }); }
};
