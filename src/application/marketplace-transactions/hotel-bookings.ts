import { FrappeSiteError, type FrappeSite } from './frappe-site.ts';
import type { HotelCapability } from './merchant-capabilities.ts';

/**
 * Hotel availability and bookings through Hospitality Core (hospitality_core).
 *
 * Availability follows Hospitality's own rule (api/reservation.py
 * check_availability): an enabled room, not Out of Order, with no Reserved or
 * Checked In reservation overlapping [arrival, departure). Public bookings use
 * no rate plan, so the nightly price is the room type's default_rate, as
 * night_audit.get_rate does. On insert, HotelReservation.validate() checks the
 * room again; a refusal there is reported as a conflict, never as a success.
 */

export interface StayQuery { arrival: string; departure: string; adults: number; children: number }

export interface RoomTypeOffer {
  roomType: string;
  description: string | null;
  maxAdults: number;
  maxChildren: number;
  available: boolean;
  availableRooms: number;
  nightlyRate: number;
  nights: number;
  total: number;
  currency: string;
}

export interface Availability extends StayQuery { nights: number; currency: string; roomTypes: RoomTypeOffer[] }

export class HotelError extends Error {
  constructor(
    readonly code: 'HOTEL_UNAVAILABLE' | 'INVALID_STAY' | 'ROOM_TYPE_NOT_FOUND' | 'OCCUPANCY_EXCEEDED' | 'ROOM_UNAVAILABLE' | 'PRICE_CHANGED' | 'CURRENCY_MISMATCH' | 'RESERVATION_NOT_RECORDED',
    readonly availability?: Availability,
  ) { super(code); }
}

const DAY = 86_400_000;
const money = (value: number) => Math.round(value * 100) / 100;

/** Today in the hotel's own time zone, as YYYY-MM-DD. */
export function hotelToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function stayNights(cap: HotelCapability, stay: StayQuery, now = new Date()): number {
  const a = Date.parse(stay.arrival + 'T00:00:00Z');
  const d = Date.parse(stay.departure + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(d)
    || new Date(a).toISOString().slice(0, 10) !== stay.arrival
    || new Date(d).toISOString().slice(0, 10) !== stay.departure) throw new HotelError('INVALID_STAY');
  const nights = Math.round((d - a) / DAY);
  if (nights < 1 || nights > cap.maxNights) throw new HotelError('INVALID_STAY');
  if (stay.arrival < hotelToday(cap.timezone, now)) throw new HotelError('INVALID_STAY');
  // Bookings are accepted up to 18 months ahead.
  if (a - now.getTime() > 548 * DAY) throw new HotelError('INVALID_STAY');
  return nights;
}

interface RoomState { byType: Map<string, string[]>; types: any[] }

async function freeRooms(site: FrappeSite, stay: StayQuery): Promise<RoomState> {
  const [types, rooms, busy] = await Promise.all([
    site.list('Hotel Room Type', [], ['name', 'default_rate', 'max_adults', 'max_children', 'description'], 200),
    site.list('Hotel Room', [['is_enabled', '=', 1], ['status', '!=', 'Out of Order']], ['name', 'room_type'], 2000),
    site.list('Hotel Reservation', [
      ['status', 'in', ['Reserved', 'Checked In']],
      ['arrival_date', '<', stay.departure],
      ['departure_date', '>', stay.arrival],
    ], ['room'], 5000),
  ]);
  const taken = new Set(busy.map((row: any) => row.room));
  const byType = new Map<string, string[]>();
  for (const room of rooms) {
    if (taken.has(room.name)) continue;
    byType.set(room.room_type, [...(byType.get(room.room_type) ?? []), room.name]);
  }
  for (const list of byType.values()) list.sort();
  return { byType, types };
}

export async function searchAvailability(site: FrappeSite, cap: HotelCapability, stay: StayQuery, now = new Date()): Promise<Availability> {
  return (await assess(site, cap, stay, now)).availability;
}

async function assess(site: FrappeSite, cap: HotelCapability, stay: StayQuery, now: Date) {
  const nights = stayNights(cap, stay, now);
  const { byType, types } = await freeRooms(site, stay);
  const roomTypes = types
    .filter((t: any) => Number(t.default_rate) > 0)
    .map((t: any): RoomTypeOffer => {
      const fits = stay.adults <= Number(t.max_adults) && stay.children <= Number(t.max_children);
      const availableRooms = fits ? (byType.get(t.name)?.length ?? 0) : 0;
      const nightlyRate = money(Number(t.default_rate));
      return {
        roomType: String(t.name), description: t.description ? String(t.description).slice(0, 500) : null,
        maxAdults: Number(t.max_adults), maxChildren: Number(t.max_children),
        available: availableRooms > 0, availableRooms, nightlyRate, nights,
        total: money(nightlyRate * nights), currency: cap.currency,
      };
    })
    .sort((a, b) => a.nightlyRate - b.nightlyRate || a.roomType.localeCompare(b.roomType));
  const availability: Availability = { arrival: stay.arrival, departure: stay.departure, adults: stay.adults, children: stay.children, nights, currency: cap.currency, roomTypes };
  return { availability, byType };
}

export interface BookingInput extends StayQuery {
  roomType: string;
  expectedTotal: number;
  currency: string;
  guest: { fullName: string; phone: string; email?: string };
}

export interface RecordedReservation {
  reference: string;
  status: string;
  roomType: string;
  arrival: string;
  departure: string;
  nights: number;
  total: number;
  currency: string;
}

/** Hospitality refused the room on insert: a concurrent booking won it. */
function isAvailabilityRefusal(error: unknown) {
  return error instanceof FrappeSiteError && error.code === 'SITE_REJECTED'
    && /already booked|availability|out of order|disabled|maintenance/i.test(error.serverMessage ?? '');
}

async function findGuest(site: FrappeSite, guest: BookingInput['guest']): Promise<string | null> {
  if (guest.email) {
    const byEmail = await site.list('Guest', [['email_id', '=', guest.email]], ['name'], 1);
    if (byEmail[0]) return byEmail[0].name;
  }
  const byPhone = await site.list('Guest', [['mobile_no', '=', guest.phone]], ['name'], 1);
  return byPhone[0]?.name ?? null;
}

async function resolveGuest(site: FrappeSite, guest: BookingInput['guest'], suffix: string): Promise<string> {
  const known = await findGuest(site, guest);
  if (known) return known;
  const doc = { guest_type: 'Regular', mobile_no: guest.phone, ...(guest.email ? { email_id: guest.email } : {}) };
  try {
    return (await site.insert('Guest', { ...doc, full_name: guest.fullName })).name;
  } catch (error) {
    // Guest is named after full_name: a namesake already exists.
    if (!(error instanceof FrappeSiteError) || error.httpStatus !== 409) throw error;
    return (await site.insert('Guest', { ...doc, full_name: `${guest.fullName} (${suffix})` })).name;
  }
}

/**
 * Re-checks availability and price, then books the first free room of the
 * type. The caller serializes bookings per (site, room type), so two Konektag
 * visitors never race for the same room; a desk booking made meanwhile is
 * caught by Hospitality's own validation and reported as ROOM_UNAVAILABLE.
 */
function fromDoc(doc: any, input: BookingInput, nights: number, total: number, currency: string): RecordedReservation {
  return {
    reference: String(doc.name), status: String(doc.status),
    roomType: String(doc.room_type ?? input.roomType),
    arrival: String(doc.arrival_date ?? input.arrival), departure: String(doc.departure_date ?? input.departure),
    nights, total, currency,
  };
}

export async function bookRoom(site: FrappeSite, cap: HotelCapability, input: BookingInput, replayKey: string, now = new Date(), resumed = false): Promise<RecordedReservation> {
  if (input.currency !== cap.currency) throw new HotelError('CURRENCY_MISMATCH');
  if (resumed) {
    // Same key, earlier attempt cut off: Frappe may already hold the booking.
    const guest = await findGuest(site, input.guest);
    const prior = guest ? await site.list('Hotel Reservation', [
      ['guest', '=', guest], ['room_type', '=', input.roomType],
      ['arrival_date', '=', input.arrival], ['departure_date', '=', input.departure],
      ['status', 'in', ['Reserved', 'Checked In']],
    ], ['name', 'status', 'room_type', 'arrival_date', 'departure_date'], 1) : [];
    if (prior[0]) return fromDoc(prior[0], input, stayNights(cap, input, now), input.expectedTotal, cap.currency);
  }
  const { availability, byType } = await assess(site, cap, input, now);
  const offer = availability.roomTypes.find(t => t.roomType === input.roomType);
  if (!offer) throw new HotelError('ROOM_TYPE_NOT_FOUND', availability);
  if (input.adults > offer.maxAdults || input.children > offer.maxChildren) throw new HotelError('OCCUPANCY_EXCEEDED', availability);
  if (!offer.available) throw new HotelError('ROOM_UNAVAILABLE', availability);
  if (Math.abs(offer.total - input.expectedTotal) >= 0.005) throw new HotelError('PRICE_CHANGED', availability);

  const candidates = (byType.get(input.roomType) ?? []).slice(0, 3);
  const rooms = await site.list('Hotel Room', [['name', 'in', candidates]], ['name', 'hotel_reception'], candidates.length);
  const reception = new Map<string, string>(rooms.map((r: any) => [r.name, r.hotel_reception]));
  const guest = await resolveGuest(site, input.guest, replayKey.slice(0, 8));

  for (const room of candidates) {
    try {
      const doc = await site.insert('Hotel Reservation', {
        naming_series: 'HR-.YYYY.-',
        hotel_reception: reception.get(room),
        guest, room_type: input.roomType, room,
        status: 'Reserved', arrival_date: input.arrival, departure_date: input.departure,
      });
      if (!doc?.name) throw new HotelError('RESERVATION_NOT_RECORDED');
      return fromDoc(doc, input, offer.nights, offer.total, cap.currency);
    } catch (error) {
      if (!isAvailabilityRefusal(error)) throw error;
    }
  }
  throw new HotelError('ROOM_UNAVAILABLE', await searchAvailability(site, cap, input, now));
}
