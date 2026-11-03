import { z } from 'zod';
import { ActivityCodeSchema } from '../../../application/merchant-activity-profile.ts';
import { MerchantNotOwnerError, MerchantActivationRequiredError } from '../../../domain/MerchantErrors.ts';
import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = z.object({ activityCode: ActivityCodeSchema, merchantProfileId: z.string().uuid().optional() }).safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422 });

  try {
    const profile = await merchantService.unpublishProfile(user.id, parsed.data.activityCode, parsed.data.merchantProfileId);
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantNotOwnerError || error instanceof MerchantActivationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, message: error.message }), { status: 403 });
    }
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/unpublish]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
