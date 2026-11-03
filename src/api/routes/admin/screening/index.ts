import type { RouteHandler } from '../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';
import { screeningBatchService } from '../../../../application/services/screening-batch-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const guard = await requireBackofficePermission('compliance:read')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const batches = await screeningBatchService.listBatches();
    return new Response(JSON.stringify({ batches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const guard = await requireBackofficePermission('compliance:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    const result = await screeningBatchService.importBatch({
      batchRef: body.batchRef || `MANUAL-${Date.now()}`,
      source: body.source || 'communication_manuelle',
      sourceDate: body.sourceDate || new Date().toISOString().slice(0, 10),
      entries: body.entries,
    }, guard.user!.id);

    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
