import { z } from 'zod';
import type { RequestContext } from '../../../../../../../http.ts';
import { boundedRequest, capability, defaultDeps, json, limited, unavailable, type TransactionDeps } from '../../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { OrderModeError, issueSelection, lookupReservations } from '../../../../../../../../application/marketplace-transactions/restaurant-modes.ts';
const schema = z.union([
  z.object({ reference: z.string().trim().min(1).max(140) }).strict(),
  z.object({ phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/) }).strict(),
]);
export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    const request = await boundedRequest(ctx.request, 4096);
    if (!request) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const body = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_LOOKUP' }, 400);
    const slug = ctx.params.slug!;
    const cap = await capability(deps, slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const visitor = 'phone' in parsed.data ? parsed.data.phone : parsed.data.reference;
    const limit = await limited(deps, ctx, 'reservation-lookup', slug, visitor, 30, 10);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const rows = await lookupReservations(deps.site(cap.site), slug, cap, parsed.data);
    return json({ reservations: rows.map(r => ({ ...r, token: issueSelection(deps!, slug, cap, r.reference) })) }, 200);
  } catch (error) {
    if (error instanceof OrderModeError) {
      const status = error.code === 'TOO_MANY_REQUESTS' ? 429 : error.code === 'CAPABILITY_NOT_AVAILABLE' ? 404 : 400;
      return json({ error: error.code }, status, status === 429 ? { 'Retry-After': '60' } : {});
    }
    const down = unavailable('reservation-lookup', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
