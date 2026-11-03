import type { RouteHandler } from '../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

const unavailable: RouteHandler = async ({ locals }) => {
  const access = await requireBackofficePermission('merchants:write')(locals);
  if (!access.authorized || access.user?.role !== 'admin') return forbiddenResponse(access.reason);
  return Response.json({ error: 'USE_MERCHANT_PRO_ACTIVATION' }, { status: 405 });
};

export const PUT = unavailable;
export const DELETE = unavailable;
