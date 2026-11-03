import type { RouteHandler } from '../../../http';
import { clearingService } from '../../../../application/services/clearing-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('clearing:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    if (body.fxRate !== undefined) {
      return new Response(JSON.stringify({ error: 'FX_CLIENT_SUPPLIED_RATE_FORBIDDEN' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const batch = await clearingService.markSettled({
      batchId: body.batchId,
      bankProofUrl: body.bankProofUrl,
      settledBy: guard.user!.id,
      cobacJustificationUrl: body.cobacJustificationUrl,
      declarationRef: body.declarationRef,
    });
    return new Response(JSON.stringify(batch), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    if (err.message === 'AUTHORITATIVE_FX_EVIDENCE_REQUIRED' || err.message === 'AUTHORITATIVE_FX_EVIDENCE_INVALID') {
      return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
