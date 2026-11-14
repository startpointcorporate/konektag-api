import { mutateBrowserActivity } from '../../../../../../../application/marketplace-transactions/browser-mutations.ts';
import { BrowserManagementError, ManagementKeySchema, creationActivity, ownerHash } from '../../../../../../../application/marketplace-transactions/browser-management.ts';
import { issueTracking, OrderModeError, placeModeOrder, readSelection } from '../../../../../../../application/marketplace-transactions/restaurant-modes.ts';
import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { boundedRequest, capability, defaultDeps, IDEMPOTENCY_KEY, json, limited, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { ReplayError, fingerprint, onceByKey } from '../../../../../../../application/marketplace-transactions/replay.ts';
import { RestaurantError, placeOrder, quoteCart } from '../../../../../../../application/marketplace-transactions/restaurant-orders.ts';

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
  orderMode: z.enum(['pickup', 'reservation']).optional(),
  reservationToken: z.string().min(40).max(2048).optional(),
  managementKey: ManagementKeySchema.optional(),
  // Honeypot, left empty by people.
  website: z.string().max(200).optional(),
}).strict();

export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  let refreshQuote: (() => ReturnType<typeof quoteCart>) | undefined;
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
    const { website, orderMode, reservationToken, managementKey, ...input } = parsed.data;
    if (managementKey && !orderMode) return json({ error: 'INVALID_ORDER' }, 400);
    if ((orderMode === 'reservation') !== Boolean(reservationToken)) return json({ error: 'INVALID_ORDER' }, 400);
    if (website) return json({ error: 'INVALID_ORDER' }, 400); // never pretend a success
    const limit = await limited(deps, ctx, 'order', slug, input.customer.phone, 60, 6);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const site = deps.site(cap.site);
    refreshQuote = () => quoteCart(site, cap, input.lines, input.currency, deps!.now().toISOString().slice(0, 10));
    const managementOwner = managementKey ? ownerHash(slug, cap, 'order', managementKey) : undefined;
    const selection = orderMode === 'reservation' ? readSelection(deps, slug, cap, reservationToken!) : undefined;
    const print = fingerprint({ slug, ...input, ...(orderMode ? { orderMode, reservationReference: selection?.reference ?? null } : {}) });
    // Explicit modes rely on Frappe's unique durable request key. Cache reads
    // must not hide a subsequent merchant cancellation, and expired selections
    // still reach its replay check before any new-write eligibility check.
    let r: Awaited<ReturnType<typeof placeOrder>> & { orderMode?: string; reservation?: unknown; replayed?: boolean; ownerVerified?: boolean; state?: 'active' | 'terminal'; createdAt?: string; version?: string; snapshot?: unknown };
    let replayed: boolean;
    if (orderMode) {
      r = await placeModeOrder(site, slug, cap, key, print, input, orderMode, selection?.reference, selection?.valid ?? true, managementOwner);
      replayed = r.replayed === true;
    } else {
      const cached = await onceByKey(deps.store(), `order:${cap.site}:${cap.posProfile}`, key, print, () => placeOrder(site, cap, key, input));
      r = cached.result; replayed = cached.replayed;
    }
    const activity = managementOwner ? creationActivity(deps, slug, cap, 'order', managementOwner, r) : undefined;
    const recorded = JSON.stringify({ reference: r.reference, status: r.status, currency: r.currency, total: r.total, lines: r.lines,
      ...(orderMode ? { orderMode: r.orderMode, reservation: r.reservation, trackingToken: issueTracking(deps, slug, cap, r.reference) } : {}), ...(activity ? { managementToken: activity.managementToken, activity } : {}), replayed });
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (replayed) return new Response(recorded, { status: 200, headers });
    return new Response(recorded, { status: 201, headers });
  } catch (error) {
    if (error instanceof BrowserManagementError) return json({ error: error.code }, error.status);
    if (error instanceof OrderModeError) {
      if (refreshQuote && ['PRICE_CHANGED', 'ITEM_UNAVAILABLE'].includes(error.code)) {
        // Only after atomic refusal: never prevalidate a durable replay.
        try { return json({ error: error.code, quote: await refreshQuote() }, 409); } catch { /* preserve the business refusal if refreshing is unavailable */ }
      }
      const status = error.code === 'TOO_MANY_REQUESTS' ? 429 : ['CAPABILITY_NOT_AVAILABLE', 'ACTIVITY_NOT_FOUND'].includes(error.code) ? 404 : error.code === 'INVALID_RESERVATION_SELECTION' || error.code === 'INVALID_ORDER' ? 400 : ['IDEMPOTENCY_KEY_REUSED', 'CURRENCY_MISMATCH'].includes(error.code) ? 422 : 409;
      return json({ error: error.code }, status, status === 429 ? { 'Retry-After': '60' } : {});
    }
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

export const PATCH = (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => mutateBrowserActivity(ctx, 'order', deps);
