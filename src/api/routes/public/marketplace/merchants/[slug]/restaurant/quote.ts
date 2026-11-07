import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { capability, defaultDeps, json, limited, MAX_BODY, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { RestaurantError, quoteCart } from '../../../../../../../application/marketplace-transactions/restaurant-orders.ts';

// Prices a cart against today's Lumen prices. Read only: nothing is recorded.
const cartLine = z.object({
  itemCode: z.string().min(1).max(140),
  quantity: z.number().int().min(1).max(50),
  unitPrice: z.number().finite().min(0).max(100_000_000),
}).strict();
const quoteSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(cartLine).min(1).max(40),
}).strict();

export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const cap = await capability(deps, ctx.params.slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    if (Number(ctx.request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const body: unknown = await ctx.request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_CART' }, 400);
    const limit = await limited(deps, ctx, 'quote', ctx.params.slug!, null, 300, 0);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const q = await quoteCart(deps.site(cap.site), cap, parsed.data.lines, parsed.data.currency, deps.now().toISOString().slice(0, 10));
    return new Response(JSON.stringify({ currency: q.currency, lines: q.lines, total: q.total, priceChanges: q.priceChanges, unavailableItems: q.unavailableItems }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RestaurantError && error.code === 'CURRENCY_MISMATCH') return json({ error: 'CURRENCY_MISMATCH' }, 422);
    if (error instanceof RestaurantError && error.code === 'RESTAURANT_UNAVAILABLE') return json({ error: 'RESTAURANT_UNAVAILABLE' }, 503);
    const down = unavailable('restaurant-quote', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
