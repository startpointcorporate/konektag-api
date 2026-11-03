import type { RouteHandler } from '../../../http';
import { clearingService } from '../../../../application/services/clearing-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('clearing:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    const batch = await clearingService.approveBatch({
      batchId: body.batchId,
      approverId: guard.user!.id,
      remarks: body.remarks,
    });
    return new Response(JSON.stringify(batch), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
