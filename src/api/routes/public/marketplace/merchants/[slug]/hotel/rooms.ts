import type { RequestContext } from '../../../../../../http';
import { CACHED, capability, defaultDeps, json, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { roomCatalogue } from '../../../../../../../application/marketplace-transactions/hotel-bookings.ts';

// Room types and starting rates behind a published hotel capability, cached 60 s.
export const GET = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const cap = await capability(deps, ctx.params.slug, 'hotel');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const rooms = await roomCatalogue(deps.site(cap.site), cap);
    return new Response(JSON.stringify({ currency: rooms.currency, checkIn: rooms.checkIn, checkOut: rooms.checkOut, roomTypes: rooms.roomTypes }), { status: 200, headers: CACHED });
  } catch (error) {
    const down = unavailable('hotel-rooms', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
