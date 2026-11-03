import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';

export const GET: RouteHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user?.id) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const profileId = new URL(request.url).searchParams.get('merchantProfileId');
  if (!profileId) return Response.json({ error: 'MERCHANT_PROFILE_REQUIRED' }, { status: 400 });
  try { await merchantService.requireOwnerOrManager(profileId, user.id); }
  catch { return Response.json({ error: 'FORBIDDEN' }, { status: 403 }); }
  const activation = await merchantActivationService.checkActivation(profileId);
  return Response.json({
    approved: activation.canOperate,
    status: activation.currentStatus,
    missingGates: activation.missingGates,
  });
};
