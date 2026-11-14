import { createHash } from 'node:crypto';
import { FrappeSiteError, type FrappePublicSite } from './frappe-site.ts';
import type { ProjectionRow } from './published-profiles.ts';

/**
 * Restaurant table requests through Lumen, via konektag_360.booking.api.submit
 * on the merchant's site. The adapter resolves the establishment from the slug,
 * checks it live (published, Restaurant, enabled, manual booking page) and
 * writes one native POS Table Reservation (source Online, status Requested).
 *
 * Replays: the adapter stores a key derived from ours on that same native row,
 * so the same Idempotency-Key and content give back the same reference, even
 * after a lost response. No cache of ours can make it disagree with Lumen.
 */

export const SUBMIT = 'konektag_360.booking.api.submit';

/** Public eligibility from the projection (konektag_360 snapshot `reservation`). */
export function reservationRequestsPublished(row: ProjectionRow | null): boolean {
  if (!row || row.status !== 'Published' || !row.capabilities.includes('restaurant')) return false;
  let s: any = row.snapshot;
  try { if (typeof s === 'string') s = JSON.parse(s); } catch { return false; }
  return s?.reservation?.enabled === true && s.reservation.mode === 'request';
}

export interface ReservationRequestInput {
  name: string;
  phone: string;
  date: string; // YYYY-MM-DD, restaurant's time zone
  time: string; // HH:mm, restaurant's time zone
  partySize: number;
  comment?: string;
}

export interface RecordedRequest { reference: string; status: string; replayed: boolean; ownerVerified?: boolean; state?: 'active' | 'terminal'; createdAt?: string; version?: string; snapshot?: unknown }

export type ReservationErrorCode =
  | 'REQUESTS_CLOSED' | 'SLOT_UNAVAILABLE' | 'PARTY_SIZE_NOT_ACCEPTED' | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_KEY_REUSED' | 'TOO_MANY_REQUESTS' | 'REQUEST_NOT_RECORDED' | 'RESERVATIONS_UNAVAILABLE' | 'ACTIVITY_NOT_FOUND' | 'MANAGEMENT_NOT_AVAILABLE';

export class ReservationError extends Error {
  constructor(readonly code: ReservationErrorCode) { super(code); }
}

/**
 * The adapter wants 20 to 100 safe characters; ours may be 16. Deterministic,
 * so a retry after any failure of ours reaches the same native row.
 */
export const requestKeyOf = (idempotencyKey: string) =>
  createHash('sha256').update('konektag-marketplace:reservation-request:' + idempotencyKey).digest('hex');

// Lumen and adapter messages (frappe.throw, ValidationError), requested in
// English. Anything else refused by the site is reported as refused, not as
// a success or an outage.
const RULES: [RegExp, ReservationErrorCode][] = [
  [/\bACTIVITY_NOT_FOUND\b/, 'ACTIVITY_NOT_FOUND'],
  [/\bMANAGEMENT_NOT_AVAILABLE\b/, 'MANAGEMENT_NOT_AVAILABLE'],
  [/Restaurant booking is unavailable|Online booking is not available|requires the native booking form/i, 'REQUESTS_CLOSED'],
  [/Request key already used/i, 'IDEMPOTENCY_KEY_REUSED'],
  [/Too many requests/i, 'TOO_MANY_REQUESTS'],
  [/smallest party|more than \d+ guests|Invalid party size/i, 'PARTY_SIZE_NOT_ACCEPTED'],
  [/time is full|Pick a day within|closed that day|take bookings between|times on the page|time has passed|Pick a time|Date and time are required/i, 'SLOT_UNAVAILABLE'],
  [/Write your name|phone number/i, 'INVALID_REQUEST'],
];

function refusal(error: FrappeSiteError): ReservationErrorCode {
  if (error.httpStatus === 429) return 'TOO_MANY_REQUESTS';
  if (error.code !== 'SITE_REJECTED') throw error; // outage: 503 upstream
  // DoesNotExistError: slug unknown on this site.
  if (error.httpStatus === 404) return 'REQUESTS_CLOSED';
  // 403: the site does not expose the method to guests (demo guard or a
  // missing deployment). An operator problem, not a closed restaurant.
  if (error.httpStatus === 403) return 'RESERVATIONS_UNAVAILABLE';
  for (const [pattern, code] of RULES) if (pattern.test(error.serverMessage ?? '')) return code;
  return error.httpStatus === 417 ? 'INVALID_REQUEST' : 'RESERVATIONS_UNAVAILABLE';
}

const STATUS = /^[A-Za-z][A-Za-z ]{0,29}$/;

export async function submitReservationRequest(site: FrappePublicSite, slug: string, idempotencyKey: string, input: ReservationRequestInput, ownerHash?: string): Promise<RecordedRequest> {
  let out: any;
  try {
    out = await site.call(SUBMIT, {
      slug,
      request_key: requestKeyOf(idempotencyKey),
      customer_name: input.name,
      phone: input.phone,
      reservation_date: input.date,
      reservation_time: input.time + ':00',
      guests: input.partySize,
      note: input.comment ?? '',
      website: '', ...(ownerHash ? { owner_hash: ownerHash } : {}),
    });
  } catch (error) {
    if (error instanceof FrappeSiteError) {
      const code = refusal(error);
      if (code === 'RESERVATIONS_UNAVAILABLE')
        console.error('[marketplace-reservation-request] refused by site', error.httpStatus, error.excType);
      throw new ReservationError(code);
    }
    throw error;
  }
  // Honeypot or unexpected answer: never present it as a recorded request.
  if (typeof out?.reference !== 'string' || !out.reference || out.reference.length > 140 || typeof out.status !== 'string' || !STATUS.test(out.status))
    throw new ReservationError('REQUEST_NOT_RECORDED');
  return { reference: out.reference, status: out.status, replayed: out.reused === true,
    ...(out.ownerVerified === true ? { ownerVerified: true, state: out.state, createdAt: out.createdAt, version: out.version, snapshot: out.snapshot } : {}) };
}
