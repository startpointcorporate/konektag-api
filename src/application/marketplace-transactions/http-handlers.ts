import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext, RouteHandler } from '../../api/http.ts';
import { FrappeSiteError, frappeSite, type FrappeSite } from './frappe-site.ts';
import { CapabilityConfigError, resolveCapability } from './merchant-capabilities.ts';
import { ReplayError, fingerprint, onceByKey, readIdempotencyKey, withLease, type ReplayStore } from './replay.ts';
import { RestaurantError, placeOrder, quoteCart } from './restaurant-orders.ts';
import { HotelError, bookRoom, searchAvailability } from './hotel-bookings.ts';

export interface TransactionDeps {
  store: () => ReplayStore;
  site: (key: string) => FrappeSite;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

const phone = z.string().trim().regex(/^\+[1-9]\d{6,14}$/);
const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(120).regex(/^[^<>{}\n\r]+$/);
const money = z.number().finite().min(0).max(100_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const cartLines = z.array(z.object({
  itemCode: z.string().min(1).max(140),
  quantity: z.number().int().min(1).max(50),
  unitPrice: money,
}).strict()).min(1).max(40);

const quoteSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), lines: cartLines }).strict();
const orderSchema = quoteSchema.extend({
  customer: z.object({ name, phone, email: email.optional() }).strict(),
  note: z.string().max(500).optional(),
  website: z.string().max(200).optional(),
}).strict();
const bookingSchema = z.object({
  roomType: z.string().min(1).max(140),
  arrival: day, departure: day,
  adults: z.number().int().min(1).max(10),
  children: z.number().int().min(0).max(10),
  expectedTotal: money,
  currency: z.string().regex(/^[A-Z]{3}$/),
  guest: z.object({ fullName: name, phone, email: email.optional() }).strict(),
  website: z.string().max(200).optional(),
}).strict();

async function readJson(request: Request, max = 16_000): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return { ok: false, response: json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415) };
  const raw = await request.text();
  if (raw.length > max) return { ok: false, response: json({ error: 'PAYLOAD_TOO_LARGE' }, 413) };
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false, response: json({ error: 'INVALID_JSON' }, 400) }; }
}

/** Per web peer, per merchant and per visitor: fail closed without Redis. */
async function limited(deps: TransactionDeps, ctx: RequestContext, scope: string, slug: string, visitor: string | null, perPeer: number, perVisitor: number) {
  try {
    const store = deps.store();
    const peer = hash(ctx.clientAddress || 'unknown-peer');
    if (!(await store.checkRateLimit(`mkt:rl:${scope}:peer:${peer}`, perPeer, 600))) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': '60' });
    if (!(await store.checkRateLimit(`mkt:rl:${scope}:merchant:${slug}`, perPeer * 2, 600))) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': '60' });
    if (visitor && !(await store.checkRateLimit(`mkt:rl:${scope}:visitor:${hash(visitor)}`, perVisitor, 3600))) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': '600' });
    return null;
  } catch {
    return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
  }
}

function failure(scope: string, error: unknown): Response {
  if (error instanceof RestaurantError) {
    const status = { RESTAURANT_UNAVAILABLE: 503, CURRENCY_MISMATCH: 422, ITEM_UNAVAILABLE: 409, PRICE_CHANGED: 409, ORDER_NOT_RECORDED: 502 }[error.code];
    return json({ error: error.code, ...(error.quote ? { quote: error.quote } : {}) }, status);
  }
  if (error instanceof HotelError) {
    const status = { HOTEL_UNAVAILABLE: 503, INVALID_STAY: 400, ROOM_TYPE_NOT_FOUND: 422, OCCUPANCY_EXCEEDED: 422, ROOM_UNAVAILABLE: 409, PRICE_CHANGED: 409, CURRENCY_MISMATCH: 422, RESERVATION_NOT_RECORDED: 502 }[error.code];
    return json({ error: error.code, ...(error.availability ? { availability: error.availability } : {}) }, status);
  }
  if (error instanceof ReplayError) {
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return json({ error: error.code }, 422);
    if (error.code === 'REQUEST_IN_PROGRESS') return json({ error: error.code }, 409, { 'Retry-After': '2' });
    return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
  }
  if (error instanceof FrappeSiteError) {
    // Never forward Frappe messages: they can name other guests or rooms.
    console.error(`[marketplace-${scope}] Frappe ${error.code}`, error.httpStatus, error.excType);
    return json({ error: error.code === 'SITE_UNAVAILABLE' ? 'SITE_UNAVAILABLE' : 'TRANSACTIONS_UNAVAILABLE' }, 503, { 'Retry-After': '30' });
  }
  if (error instanceof CapabilityConfigError) console.error(`[marketplace-${scope}] ${error.message}`);
  else console.error(`[marketplace-${scope}] unexpected failure`, error instanceof Error ? error.name : typeof error);
  return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
}

function capability(deps: TransactionDeps, slug: string | undefined, kind: 'restaurant' | 'hotel') {
  return resolveCapability(slug ?? '', kind as any, deps.env) as any;
}

export function restaurantHandlers(deps: TransactionDeps): { quote: RouteHandler; order: RouteHandler } {
  const quote: RouteHandler = async ctx => {
    try {
      const cap = capability(deps, ctx.params.slug, 'restaurant');
      if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
      const body = await readJson(ctx.request);
      if (!body.ok) return body.response;
      const parsed = quoteSchema.safeParse(body.value);
      if (!parsed.success) return json({ error: 'INVALID_CART' }, 400);
      const limit = await limited(deps, ctx, 'quote', ctx.params.slug!, null, 300, 0);
      if (limit) return limit;
      return json(await quoteCart(deps.site(cap.site), cap, parsed.data.lines, parsed.data.currency, deps.now().toISOString().slice(0, 10)), 200);
    } catch (error) { return failure('restaurant-quote', error); }
  };

  const order: RouteHandler = async ctx => {
    try {
      const slug = ctx.params.slug!;
      const cap = capability(deps, slug, 'restaurant');
      if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
      const key = readIdempotencyKey(ctx.request);
      if (!key) return json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
      const body = await readJson(ctx.request);
      if (!body.ok) return body.response;
      const parsed = orderSchema.safeParse(body.value);
      if (!parsed.success) return json({ error: 'INVALID_ORDER' }, 400);
      const { website, ...input } = parsed.data;
      if (website) return json({ error: 'INVALID_ORDER' }, 400); // honeypot: never pretend a success
      const limit = await limited(deps, ctx, 'order', slug, input.customer.phone, 60, 6);
      if (limit) return limit;
      const site = deps.site(cap.site);
      const { result, replayed } = await onceByKey(deps.store(), `order:${cap.site}:${cap.posProfile}`, key, fingerprint({ slug, ...input }),
        () => placeOrder(site, cap, key, input));
      return json({ ...result, replayed }, replayed ? 200 : 201);
    } catch (error) { return failure('restaurant-order', error); }
  };
  return { quote, order };
}

export function hotelHandlers(deps: TransactionDeps): { availability: RouteHandler; reserve: RouteHandler } {
  const availability: RouteHandler = async ctx => {
    try {
      const cap = capability(deps, ctx.params.slug, 'hotel');
      if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
      const q = ctx.url.searchParams;
      const parsed = z.object({
        arrival: day, departure: day,
        adults: z.coerce.number().int().min(1).max(10),
        children: z.coerce.number().int().min(0).max(10).default(0),
      }).safeParse({ arrival: q.get('arrival'), departure: q.get('departure'), adults: q.get('adults'), children: q.get('children') ?? undefined });
      if (!parsed.success) return json({ error: 'INVALID_STAY' }, 400);
      const limit = await limited(deps, ctx, 'availability', ctx.params.slug!, null, 300, 0);
      if (limit) return limit;
      return json(await searchAvailability(deps.site(cap.site), cap, parsed.data, deps.now()), 200);
    } catch (error) { return failure('hotel-availability', error); }
  };

  const reserve: RouteHandler = async ctx => {
    try {
      const slug = ctx.params.slug!;
      const cap = capability(deps, slug, 'hotel');
      if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
      const key = readIdempotencyKey(ctx.request);
      if (!key) return json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
      const body = await readJson(ctx.request);
      if (!body.ok) return body.response;
      const parsed = bookingSchema.safeParse(body.value);
      if (!parsed.success) return json({ error: 'INVALID_RESERVATION' }, 400);
      const { website, ...input } = parsed.data;
      if (website) return json({ error: 'INVALID_RESERVATION' }, 400);
      const limit = await limited(deps, ctx, 'reservation', slug, input.guest.phone, 30, 4);
      if (limit) return limit;
      const site = deps.site(cap.site);
      const store = deps.store();
      const { result, replayed } = await onceByKey(store, `reservation:${cap.site}`, key, fingerprint({ slug, ...input }),
        // One Konektag booking at a time per room type: no double booking between visitors.
        resumed => withLease(store, `mkt:lease:hotel:${cap.site}:${hash(input.roomType)}`, () => bookRoom(site, cap, input, key, deps.now(), resumed)));
      return json({ ...result, replayed }, replayed ? 200 : 201);
    } catch (error) { return failure('hotel-reservation', error); }
  };
  return { availability, reserve };
}

export async function defaultDeps(): Promise<TransactionDeps> {
  const { redisAdapter } = await import('../../infrastructure/adapters/redis-adapter.ts');
  return { store: () => redisAdapter, site: key => frappeSite(key), env: process.env, now: () => new Date() };
}
