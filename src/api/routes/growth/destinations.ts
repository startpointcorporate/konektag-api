import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { createDestination, resolveDestination } from '../../../application/growth-service.ts';

const Schema = z.object({
  merchantId: z.string().uuid(), targetType: z.enum(['profile', 'catalog', 'offer']),
  targetId: z.string().uuid().optional(), targetRef: z.string().min(1).max(100).optional(), channel: z.string().min(1).max(40).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(JSON.stringify({ error: 'INVALID_REQUEST', details: parsed.error.flatten() }), { status: 422 });
  try {
    const destination = await createDestination({ ...parsed.data, actorId: locals.user.id });
    return new Response(JSON.stringify({ ...destination, url: (await resolveDestination(destination.id,destination.attribution_id)).path }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    const status = ['TARGET_NOT_FOUND', 'DESTINATION_NOT_FOUND'].includes(error.message) ? 404 : error.message === 'TARGET_NOT_ACTIVE' ? 409 : error.status ?? 403;
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
