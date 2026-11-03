import type { RouteHandler } from '../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';
import { cardLifecycleService } from '../../../../application/services/card-lifecycle-service.ts';

export const POST: RouteHandler = async ({ locals, request }) => {
  const guard = await requireBackofficePermission('cards:write')(locals);
  if (!guard.authorized || !guard.user) return forbiddenResponse();
  const body = await request.json().catch(() => null);
  if (!body || !['DISTRIBUTE', 'CANCEL', 'BLOCK'].includes(body.action) || typeof body.batchId !== 'string' || typeof body.reason !== 'string' || !body.reason.trim()) return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  await cardLifecycleService.transitionBatch({ batchId: body.batchId, action: body.action, actorId: guard.user.id, reason: body.reason.trim() });
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
};
