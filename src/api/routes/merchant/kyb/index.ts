import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError, MerchantCertificationIncompleteError } from '../../../../domain/MerchantErrors.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    return Response.json(await merchantService.getCertificationDossier(user.id));
  } catch (error) {
    if (error instanceof MerchantProfileNotFoundError) return Response.json({ error: 'NOT_FOUND', message: error.message }, { status: 404 });
    console.error('[merchant/kyb GET]', error);
    return Response.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const { action } = await request.json();
    if (action !== 'submit') return Response.json({ error: 'INVALID_ACTION' }, { status: 400 });
    return Response.json(await merchantService.submitKyb(user.id));
  } catch (error: any) {
    if (error instanceof MerchantCertificationIncompleteError) return Response.json({ error: 'INCOMPLETE', message: error.message }, { status: 422 });
    if (error instanceof MerchantProfileNotFoundError) return Response.json({ error: 'NOT_FOUND', message: error.message }, { status: 404 });
    console.error('[merchant/kyb POST]', error);
    return Response.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
};
