import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('settlements:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    const result = await settlementService.approveSettlement(
        body.settlementId,
      guard.user!.id,
        true,
    );
    if (!result.ok) return forbiddenResponse(result.error);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
