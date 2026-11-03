import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('settlements:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  try {
    await request.json();
    return new Response(JSON.stringify({ error: 'SETTLEMENT_CONFIRMATION_REQUIRES_PROVIDER_CALLBACK_OR_RECONCILED_STATEMENT' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), { status: 400 });
  }
};
