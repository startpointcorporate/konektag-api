import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profile = await merchantService.suspendProfile(user.id);
    return new Response(JSON.stringify(profile), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    console.error('[merchant/suspend]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
