import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { capability, defaultDeps, hash, IDEMPOTENCY_KEY, json, limited, MAX_BODY, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { ReplayError, fingerprint, onceByKey, withLease } from '../../../../../../../application/marketplace-transactions/replay.ts';
import { HotelError, bookRoom } from '../../../../../../../application/marketplace-transactions/hotel-bookings.ts';

// Records a Hospitality Hotel Reservation once per Idempotency-Key.
const bookingSchema = z.object({
  roomType: z.string().min(1).max(140),
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().min(1).max(10),
  children: z.number().int().min(0).max(10),
  // Total shown to the visitor by the availability search.
  expectedTotal: z.number().finite().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  guest: z.object({
    fullName: z.string().trim().min(2).max(120).regex(/^[^<>{}\n\r]+$/),
    phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  }).strict(),
  // Honeypot, left empty by people.
  website: z.string().max(200).optional(),
}).strict();

export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const slug = ctx.params.slug!;
    const cap = await capability(deps, slug, 'hotel');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const key = ctx.request.headers.get('idempotency-key') ?? ctx.request.headers.get('x-idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) return json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    if (Number(ctx.request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const body: unknown = await ctx.request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
    const parsed = bookingSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_RESERVATION' }, 400);
    const { website, ...input } = parsed.data;
    if (website) return json({ error: 'INVALID_RESERVATION' }, 400);
    const limit = await limited(deps, ctx, 'reservation', slug, input.guest.phone, 30, 4);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const site = deps.site(cap.site);
    const store = deps.store();
    const now = deps.now();
    const { result: r, replayed } = await onceByKey(store, `reservation:${cap.site}`, key, fingerprint({ slug, ...input }),
      // One Konektag booking at a time per room type: no double booking between visitors.
      replay => withLease(store, `mkt:lease:hotel:${cap.site}:${hash(input.roomType)}`, () => bookRoom(site, cap, input, key, now, replay)));
    const recorded = JSON.stringify({ reference: r.reference, status: r.status, roomType: r.roomType, arrival: r.arrival, departure: r.departure, nights: r.nights, total: r.total, currency: r.currency, replayed });
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (replayed) return new Response(recorded, { status: 200, headers });
    return new Response(recorded, { status: 201, headers });
  } catch (error) {
    const availability = error instanceof HotelError && error.availability ? { availability: error.availability } : {};
    if (error instanceof HotelError && error.code === 'ROOM_UNAVAILABLE') return json({ error: 'ROOM_UNAVAILABLE', ...availability }, 409);
    if (error instanceof HotelError && error.code === 'PRICE_CHANGED') return json({ error: 'PRICE_CHANGED', ...availability }, 409);
    // Interrupted write without a unique external reference: never book twice.
    if (error instanceof HotelError && error.code === 'RESERVATION_OUTCOME_UNKNOWN') return json({ error: 'RESERVATION_OUTCOME_UNKNOWN', ...availability }, 409);
    if (error instanceof HotelError && error.code === 'INVALID_STAY') return json({ error: 'INVALID_STAY', ...availability }, 400);
    if (error instanceof HotelError && error.code === 'ROOM_TYPE_NOT_FOUND') return json({ error: 'ROOM_TYPE_NOT_FOUND', ...availability }, 422);
    if (error instanceof HotelError && error.code === 'OCCUPANCY_EXCEEDED') return json({ error: 'OCCUPANCY_EXCEEDED', ...availability }, 422);
    if (error instanceof HotelError && error.code === 'CURRENCY_MISMATCH') return json({ error: 'CURRENCY_MISMATCH', ...availability }, 422);
    if (error instanceof HotelError && error.code === 'RESERVATION_NOT_RECORDED') return json({ error: 'RESERVATION_NOT_RECORDED', ...availability }, 502);
    if (error instanceof ReplayError && error.code === 'IDEMPOTENCY_KEY_REUSED') return json({ error: 'IDEMPOTENCY_KEY_REUSED' }, 422);
    if (error instanceof ReplayError && error.code === 'REQUEST_IN_PROGRESS') return json({ error: 'REQUEST_IN_PROGRESS' }, 409, { 'Retry-After': '2' });
    const down = unavailable('hotel-reservation', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
