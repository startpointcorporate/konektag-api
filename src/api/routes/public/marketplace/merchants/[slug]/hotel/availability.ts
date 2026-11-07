import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { capability, defaultDeps, json, limited, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { HotelError, searchAvailability } from '../../../../../../../application/marketplace-transactions/hotel-bookings.ts';

// Live Hospitality availability by dates and travellers. Read only.
const stay = z.object({
  arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.coerce.number().int().min(1).max(10),
  children: z.coerce.number().int().min(0).max(10).default(0),
});

export const GET = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const cap = await capability(deps, ctx.params.slug, 'hotel');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const parsed = stay.safeParse({
      arrival: ctx.url.searchParams.get('arrival'),
      departure: ctx.url.searchParams.get('departure'),
      adults: ctx.url.searchParams.get('adults'),
      children: ctx.url.searchParams.get('children') ?? undefined,
    });
    if (!parsed.success) return json({ error: 'INVALID_STAY' }, 400);
    const limit = await limited(deps, ctx, 'availability', ctx.params.slug!, null, 300, 0);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const a = await searchAvailability(deps.site(cap.site), cap, parsed.data, deps.now());
    return new Response(JSON.stringify({ arrival: a.arrival, departure: a.departure, adults: a.adults, children: a.children, nights: a.nights, currency: a.currency, roomTypes: a.roomTypes }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof HotelError && error.code === 'INVALID_STAY') return json({ error: 'INVALID_STAY' }, 400);
    const down = unavailable('hotel-availability', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
