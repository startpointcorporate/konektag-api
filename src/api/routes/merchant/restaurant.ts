import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { z } from 'zod';
import { RestaurantSchema } from '../../../application/merchant-activity-profile.ts';
import { MerchantNotOwnerError, MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';

const Schema = RestaurantSchema.extend({ merchantProfileId: z.string().uuid() });

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await merchantService.saveRestaurantProfile(user.id, parsed.data);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    if (error instanceof MerchantNotOwnerError) return new Response(JSON.stringify({ error: error.code }), { status: 403 });
    if (error instanceof MerchantProfileNotFoundError) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    console.error('[merchant/restaurant]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500 });
  }
};
