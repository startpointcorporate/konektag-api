import type { RouteHandler } from '../../../http';
import { userApiKeyService } from '../../../../application/services/user-api-key-service.ts';
import { managementGuard } from './index.ts';

export const DELETE: RouteHandler = async ({ request, locals, params }) => {
  const denied = managementGuard(request, locals, true);
  if (denied) return denied;
  const id = params.id || '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    return Response.json({ error: 'INVALID_ID' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const revoked = await userApiKeyService.revoke(locals.user!.id, id);
    return Response.json(revoked ? { revoked: true } : { error: 'NOT_FOUND' }, {
      status: revoked ? 200 : 404, headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'API_KEY_REVOKE_FAILED' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
};
