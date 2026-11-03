import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../../domain/MerchantErrors.ts';
import { z } from 'zod';

const BodySchema = z.object({
  orders: z.array(z.object({ id: z.string().uuid(), displayOrder: z.number().min(0) })),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await merchantService.reorderMedia(user.id, parsed.data.orders);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    console.error('[merchant/media/reorder]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
