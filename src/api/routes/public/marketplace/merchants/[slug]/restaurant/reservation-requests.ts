import { z } from 'zod';
import type { RequestContext } from '../../../../../../http';
import { boundedRequest, defaultDeps, IDEMPOTENCY_KEY, json, limited, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { resolveCapability } from '../../../../../../../application/marketplace-transactions/merchant-capabilities.ts';
import {
  ReservationError, reservationRequestsPublished, submitReservationRequest,
} from '../../../../../../../application/marketplace-transactions/restaurant-reservation-requests.ts';

// Sends a table request to Lumen (POS Table Reservation, Online, Requested).
// The restaurant confirms or refuses it; this never answers a confirmed table.
const isDay = (v: string) => {
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const requestSchema = z.object({
  name: z.string().trim().min(2).max(120).regex(/^[^<>{}\n\r]+$/),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDay),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  partySize: z.number().int().min(1).max(50),
  comment: z.string().trim().max(500).optional(),
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
    // Site from the server-side routing, eligibility from the published
    // projection; Lumen checks both again live at submission.
    const cap = resolveCapability(slug, 'restaurant', deps.env);
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const row = await deps.profiles().bySlug(slug);
    if (!reservationRequestsPublished(row)) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const body: unknown = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 400);
    const { website, comment, ...rest } = parsed.data;
    if (website) return json({ error: 'INVALID_REQUEST' }, 400); // never pretend a success
    const site = deps.publicSite(cap.site);
    // The establishment is published by that site and no other: a visitor's
    // details never go to a site that does not own the slug.
    if (row!.source_site !== site.host && !site.host.endsWith('.svc.cluster.local')) {
      console.error('[marketplace-reservation-request] projection site does not match the routing', cap.site);
      return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    }
    const limit = await limited(deps, ctx, 'reservation-request', slug, rest.phone, 30, 5);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': limit.retryAfter });
    const r = await submitReservationRequest(site, slug, key, { ...rest, ...(comment ? { comment } : {}) });
    const recorded = JSON.stringify({ reference: r.reference, status: r.status, replayed: r.replayed });
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (r.replayed) return new Response(recorded, { status: 200, headers });
    return new Response(recorded, { status: 201, headers });
  } catch (error) {
    if (error instanceof ReservationError && error.code === 'REQUESTS_CLOSED') return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    if (error instanceof ReservationError && error.code === 'SLOT_UNAVAILABLE') return json({ error: 'SLOT_UNAVAILABLE' }, 409);
    if (error instanceof ReservationError && error.code === 'PARTY_SIZE_NOT_ACCEPTED') return json({ error: 'PARTY_SIZE_NOT_ACCEPTED' }, 422);
    if (error instanceof ReservationError && error.code === 'INVALID_REQUEST') return json({ error: 'INVALID_REQUEST' }, 422);
    if (error instanceof ReservationError && error.code === 'IDEMPOTENCY_KEY_REUSED') return json({ error: 'IDEMPOTENCY_KEY_REUSED' }, 422);
    if (error instanceof ReservationError && error.code === 'TOO_MANY_REQUESTS') return json({ error: 'TOO_MANY_REQUESTS' }, 429, { 'Retry-After': '600' });
    if (error instanceof ReservationError && error.code === 'REQUEST_NOT_RECORDED') return json({ error: 'REQUEST_NOT_RECORDED' }, 502);
    if (error instanceof ReservationError && error.code === 'RESERVATIONS_UNAVAILABLE') return json({ error: 'RESERVATIONS_UNAVAILABLE' }, 503, { 'Retry-After': '30' });
    const down = unavailable('reservation-request', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
