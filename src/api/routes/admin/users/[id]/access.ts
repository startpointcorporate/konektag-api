import type { RouteHandler } from '../../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';
import { changeAccountAccess } from '../../../../../application/services/account-access-service.ts';

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const guard = await requireBackofficePermission('compliance:write')(locals);
  if (!guard.authorized || !guard.user) return forbiddenResponse();
  const body = await request.json().catch(() => null);
  if (!body || typeof body.blocked !== 'boolean' || typeof body.reason !== 'string' || !body.reason.trim()) return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  const key = request.headers.get('x-idempotency-key');
  if (!key) return new Response(JSON.stringify({ error: 'IDEMPOTENCY_KEY_REQUIRED' }), { status: 400 });
  const result = await changeAccountAccess({ userId: params.id!, actorId: guard.user.id, blocked: body.blocked, reason: body.reason.trim(), idempotencyKey: key });
  return new Response(JSON.stringify(result), { status: result.success ? 200 : 202, headers: { 'Content-Type': 'application/json' } });
};
