import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { boundedRequest, capability, defaultDeps, IDEMPOTENCY_KEY, json, limited, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { ReplayError, fingerprint, onceByKey } from '../../../../../../../application/marketplace-transactions/replay.ts';
import { RestaurantError, placeOrder } from '../../../../../../../application/marketplace-transactions/restaurant-orders.ts';

// Records a Lumen POS Restaurant Order once per Idempotency-Key.
const cartLine = z.object({
  itemCode: z.string().min(1).max(140),
  quantity: z.number().int().min(1).max(50),
  unitPrice: z.number().finite().min(0).max(100_000_000),
}).strict();
const orderSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(cartLine).min(1).max(40),
  customer: z.object({
    name: z.string().trim().min(2).max(120).regex(/^[^<>{}\n\r]+$/),
    phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  }).strict(),
  note: z.string().max(500).optional(),
  // Honeypot, left empty by people.
  website: z.string().max(200).optional(),
}).strict();

export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const slug = ctx.params.slug!;
    const key = ctx.request.headers.get('idempotency-key') ?? ctx.request.headers.get('x-idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) return json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    // Capped on the bytes actually read, before any JSON parsing or Frappe call.
    const request = await boundedRequest(ctx.request);
    if (!request) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const cap = await capability(deps, slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const body: unknown = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_ORDER' }, 400);
    const { website, ...input } = parsed.data;
    if (website) return json({ error: 'INVALID_ORDER' }, 400); // never pretend a success
    const limit = await limited(deps, ctx, 'order', slug, input.customer.phone, 60, 6);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const site = deps.site(cap.site);
    const { result: r, replayed } = await onceByKey(deps.store(), `order:${cap.site}:${cap.posProfile}`, key, fingerprint({ slug, ...input }),
      () => placeOrder(site, cap, key, input));
    const recorded = JSON.stringify({ reference: r.reference, status: r.status, currency: r.currency, total: r.total, lines: r.lines, replayed });
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (replayed) return new Response(recorded, { status: 200, headers });
    return new Response(recorded, { status: 201, headers });
  } catch (error) {
    const quote = error instanceof RestaurantError && error.quote ? { quote: error.quote } : {};
    if (error instanceof RestaurantError && error.code === 'PRICE_CHANGED') return json({ error: 'PRICE_CHANGED', ...quote }, 409);
    if (error instanceof RestaurantError && error.code === 'ITEM_UNAVAILABLE') return json({ error: 'ITEM_UNAVAILABLE', ...quote }, 409);
    if (error instanceof RestaurantError && error.code === 'CURRENCY_MISMATCH') return json({ error: 'CURRENCY_MISMATCH', ...quote }, 422);
    if (error instanceof RestaurantError && error.code === 'ORDER_NOT_RECORDED') return json({ error: 'ORDER_NOT_RECORDED', ...quote }, 502);
    if (error instanceof RestaurantError && error.code === 'RESTAURANT_UNAVAILABLE') return json({ error: 'RESTAURANT_UNAVAILABLE', ...quote }, 503);
    if (error instanceof ReplayError && error.code === 'IDEMPOTENCY_KEY_REUSED') return json({ error: 'IDEMPOTENCY_KEY_REUSED' }, 422);
    if (error instanceof ReplayError && error.code === 'REQUEST_IN_PROGRESS') return json({ error: 'REQUEST_IN_PROGRESS' }, 409, { 'Retry-After': '2' });
    const down = unavailable('restaurant-order', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
