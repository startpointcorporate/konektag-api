import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { FrappeSiteError, frappeSite, type FrappeSite, type Filter } from '../../src/application/marketplace-transactions/frappe-site.ts';
import { hotelHandlers, restaurantHandlers, type TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
import { resolveCapability } from '../../src/application/marketplace-transactions/merchant-capabilities.ts';
import type { ReplayStore } from '../../src/application/marketplace-transactions/replay.ts';

// ── fakes ────────────────────────────────────────────────────────────────

class MemoryStore implements ReplayStore {
  data = new Map<string, string>();
  down = false;
  async setIfAbsent(key: string, value: string) { this.check(); if (this.data.has(key)) return false; this.data.set(key, value); return true; }
  async deleteIfEquals(key: string, value: string) { if (this.data.get(key) === value) this.data.delete(key); }
  async getValue(key: string) { this.check(); return this.data.get(key) ?? null; }
  async setValue(key: string, value: string) { this.check(); this.data.set(key, value); }
  async checkRateLimit(key: string, max: number) {
    this.check();
    const n = Number(this.data.get(key) ?? 0) + 1; this.data.set(key, String(n)); return n <= max;
  }
  private check() { if (this.down) throw new Error('redis down'); }
}

function matches(doc: any, [field, op, value]: Filter) {
  const v = doc[field];
  switch (op) {
    case '=': return v === value;
    case '!=': return v !== value;
    case 'in': return (value as unknown[]).includes(v);
    case '<': return v < (value as any);
    case '>': return v > (value as any);
    default: throw new Error('op ' + op);
  }
}

/** In-memory Frappe site applying the Lumen and Hospitality rules we rely on. */
class FakeSite implements FrappeSite {
  docs = new Map<string, any[]>();
  calls: string[] = [];
  seq = 0;
  failNext: Record<string, Error> = {};
  constructor(readonly key: string, readonly host = key.toLowerCase() + '.example') {}
  table(doctype: string) { if (!this.docs.has(doctype)) this.docs.set(doctype, []); return this.docs.get(doctype)!; }
  add(doctype: string, doc: any) { this.table(doctype).push(doc); return doc; }
  private maybeFail(op: string) { const e = this.failNext[op]; if (e) { delete this.failNext[op]; throw e; } }
  async list(doctype: string, filters: Filter[], fields: string[]) {
    this.calls.push('list:' + doctype);
    return this.table(doctype).filter(d => filters.every(f => matches(d, f)))
      .map(d => Object.fromEntries(fields.map(f => [f, d[f]])));
  }
  async get(doctype: string, name: string) {
    this.calls.push('get:' + doctype);
    const doc = this.table(doctype).find(d => d.name === name);
    if (!doc) throw new FrappeSiteError('SITE_REJECTED', 404, 'DoesNotExistError');
    return structuredClone(doc);
  }
  async insert(doctype: string, doc: any) {
    this.calls.push('insert:' + doctype);
    this.maybeFail('insert:' + doctype);
    if (doctype === 'Guest') {
      if (this.table('Guest').some(g => g.name === doc.full_name)) throw new FrappeSiteError('SITE_REJECTED', 409, 'DuplicateEntryError');
      return this.add('Guest', { ...doc, name: doc.full_name });
    }
    if (doctype === 'Hotel Reservation') {
      // HotelReservation.validate() → check_availability()
      const clash = this.table('Hotel Reservation').find(r => r.room === doc.room && ['Reserved', 'Checked In'].includes(r.status)
        && doc.arrival_date < r.departure_date && doc.departure_date > r.arrival_date);
      if (clash) throw new FrappeSiteError('SITE_REJECTED', 417, 'ValidationError', `Room ${doc.room} is already booked by someone`);
      const saved = this.add(doctype, { ...doc, name: `HR-2026-${String(++this.seq).padStart(5, '0')}` });
      this.maybeFail('after:Hotel Reservation');
      return saved;
    }
    throw new Error('insert ' + doctype);
  }
  async call(method: string, args: any) {
    this.calls.push('call:' + method);
    this.maybeFail('call:' + method);
    if (method === 'lumen_restaurants.api.restaurant.open_order')
      return this.add('POS Restaurant Order', { name: `ORD-2026-${String(++this.seq).padStart(5, '0')}`, status: 'Open', items: [],
        pos_profile: args.pos_profile, app_type: args.app_type, order_id: args.order_id, order_type: args.order_type, note: args.note });
    if (method === 'lumen_restaurants.api.restaurant.save_order') {
      const doc = this.table('POS Restaurant Order').find(d => d.name === args.name)!;
      doc.items = args.cart.lines.map((l: any) => ({ item_code: l.item_code, item_name: l.item_name, qty: l.qty, rate: l.price, amount: l.qty * l.price }));
      this.maybeFail('after:save_order');
      return { name: doc.name, status: doc.status };
    }
    throw new Error('call ' + method);
  }
}

function restaurantSite() {
  const site = new FakeSite('RESTODEMO');
  site.add('POS Profile', { name: 'Feane Brazzaville', lumenpos_restaurant_mode: 1, disabled: 0, selling_price_list: 'Carte', item_groups: [{ item_group: 'Plats' }] });
  site.add('Price List', { name: 'Carte', currency: 'XAF', enabled: 1 });
  site.add('Item Group', { name: 'Plats', lft: 1, rgt: 6 });
  site.add('Item Group', { name: 'Burgers', lft: 2, rgt: 3 });
  site.add('Item Group', { name: 'Boutique', lft: 7, rgt: 8 });
  site.add('Item', { name: 'BURGER', item_name: 'Burger maison', item_group: 'Burgers', stock_uom: 'Nos', is_sales_item: 1, disabled: 0, has_variants: 0 });
  site.add('Item', { name: 'FRITES', item_name: 'Frites', item_group: 'Plats', stock_uom: 'Nos', is_sales_item: 1, disabled: 0, has_variants: 0 });
  site.add('Item', { name: 'TSHIRT', item_name: 'T-shirt', item_group: 'Boutique', stock_uom: 'Nos', is_sales_item: 1, disabled: 0, has_variants: 0 });
  site.add('Item', { name: 'OLD', item_name: 'Ancien plat', item_group: 'Plats', stock_uom: 'Nos', is_sales_item: 1, disabled: 1, has_variants: 0 });
  site.add('Item Price', { item_code: 'BURGER', price_list: 'Carte', selling: 1, price_list_rate: 4500, uom: 'Nos', valid_from: '2026-01-01' });
  site.add('Item Price', { item_code: 'BURGER', price_list: 'Carte', selling: 1, price_list_rate: 9999, uom: 'Nos', valid_from: '2027-01-01' });
  site.add('Item Price', { item_code: 'FRITES', price_list: 'Carte', selling: 1, price_list_rate: 1500, uom: 'Nos' });
  site.add('Item Price', { item_code: 'TSHIRT', price_list: 'Carte', selling: 1, price_list_rate: 8000, uom: 'Nos' });
  site.add('Item Price', { item_code: 'OLD', price_list: 'Carte', selling: 1, price_list_rate: 100, uom: 'Nos' });
  return site;
}

function hotelSite() {
  const site = new FakeSite('HOTELDEMO');
  site.add('Hotel Room Type', { name: 'Standard', default_rate: 35000, max_adults: 2, max_children: 1, description: 'Chambre double' });
  site.add('Hotel Room Type', { name: 'Suite', default_rate: 90000, max_adults: 4, max_children: 2, description: null });
  site.add('Hotel Room', { name: '101', room_type: 'Standard', is_enabled: 1, status: 'Available', hotel_reception: 'Réception' });
  site.add('Hotel Room', { name: '102', room_type: 'Standard', is_enabled: 1, status: 'Available', hotel_reception: 'Réception' });
  site.add('Hotel Room', { name: '201', room_type: 'Suite', is_enabled: 1, status: 'Out of Order', hotel_reception: 'Réception' });
  return site;
}

const env = {
  MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
    'feane-brazzaville': { restaurant: { site: 'RESTODEMO', posProfile: 'Feane Brazzaville' } },
    'hotelier-brazzaville': { hotel: { site: 'HOTELDEMO', currency: 'XAF' } },
    'boutique-standard': {},
  }),
} as NodeJS.ProcessEnv;

const NOW = new Date('2026-11-06T10:00:00Z');

function setup() {
  const store = new MemoryStore();
  const sites: Record<string, FakeSite> = { RESTODEMO: restaurantSite(), HOTELDEMO: hotelSite() };
  const used: string[] = [];
  const deps: TransactionDeps = { store: () => store, site: key => { used.push(key); return sites[key]; }, env, now: () => NOW };
  return { store, sites, used, resto: restaurantHandlers(deps), hotel: hotelHandlers(deps) };
}

const KEY = 'web-3f6c2a4e-9b1d-4c7e-8f00-1234567890ab';
function post(path: string, body: unknown, key: string | null = KEY, slug = path.split('/')[5]) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  return createContext(new Request('https://api.test' + path, { method: 'POST', headers, body: JSON.stringify(body) }), { slug }, '10.0.0.5');
}
function get(path: string, slug = path.split('/')[5]) {
  return createContext(new Request('https://api.test' + path), { slug }, '10.0.0.5');
}

const order = (lines = [{ itemCode: 'BURGER', quantity: 2, unitPrice: 4500 }, { itemCode: 'FRITES', quantity: 1, unitPrice: 1500 }]) => ({
  currency: 'XAF', lines, customer: { name: 'Awa Mabiala', phone: '+242061234567' },
});
const ORDER_PATH = '/api/public/marketplace/merchants/feane-brazzaville/restaurant/orders';
const QUOTE_PATH = '/api/public/marketplace/merchants/feane-brazzaville/restaurant/quote';
const RES_PATH = '/api/public/marketplace/merchants/hotelier-brazzaville/hotel/reservations';
const AV_PATH = '/api/public/marketplace/merchants/hotelier-brazzaville/hotel/availability';
const booking = (over: Record<string, unknown> = {}) => ({
  roomType: 'Standard', arrival: '2026-11-20', departure: '2026-11-22', adults: 2, children: 0,
  expectedTotal: 70000, currency: 'XAF', guest: { fullName: 'Jean Ngoma', phone: '+242069876543', email: 'jean@example.com' }, ...over,
});

// ── capability routing ───────────────────────────────────────────────────

describe('merchant capability routing', () => {
  it('resolves the site server-side and hides absent capabilities', () => {
    expect(resolveCapability('feane-brazzaville', 'restaurant', env)?.site).toBe('RESTODEMO');
    expect(resolveCapability('feane-brazzaville', 'hotel', env)).toBeNull();
    expect(resolveCapability('boutique-standard', 'restaurant', env)).toBeNull();
    expect(resolveCapability('__proto__', 'restaurant', env)).toBeNull();
    expect(resolveCapability('constructor', 'hotel', env)).toBeNull();
  });

  it('answers 404 for a capability the merchant does not publish, without touching Frappe', async () => {
    const t = setup();
    const res = await t.hotel.availability(get('/api/public/marketplace/merchants/feane-brazzaville/hotel/availability?arrival=2026-11-20&departure=2026-11-21&adults=1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CAPABILITY_NOT_AVAILABLE');
    const std = await t.resto.order(post('/api/public/marketplace/merchants/boutique-standard/restaurant/orders', order()));
    expect(std.status).toBe(404);
    expect(t.used).toEqual([]);
  });

  it('keeps the restaurant and hotel sites isolated', async () => {
    const t = setup();
    await t.resto.order(post(ORDER_PATH, order()));
    await t.hotel.reserve(post(RES_PATH, booking(), 'web-hotel-key-000000000001'));
    expect(t.sites.RESTODEMO.calls.some(c => c.includes('Hotel'))).toBe(false);
    expect(t.sites.HOTELDEMO.calls.some(c => c.includes('lumen') || c.includes('POS'))).toBe(false);
    expect(new Set(t.used)).toEqual(new Set(['RESTODEMO', 'HOTELDEMO']));
  });
});

describe('Frappe site client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires site-specific service credentials and never accepts HTTP outside the cluster', () => {
    expect(() => frappeSite('RESTODEMO', {})).toThrow('SITE_NOT_CONFIGURED');
    expect(() => frappeSite('restodemo', { MARKETPLACE_FRAPPE_restodemo_URL: 'https://x/' })).toThrow('SITE_NOT_CONFIGURED');
    const base = { MARKETPLACE_FRAPPE_RESTODEMO_API_KEY: 'k', MARKETPLACE_FRAPPE_RESTODEMO_API_SECRET: 's' };
    expect(() => frappeSite('RESTODEMO', { ...base, MARKETPLACE_FRAPPE_RESTODEMO_URL: 'http://restodemo.konektag.eu/' })).toThrow('SITE_NOT_CONFIGURED');
    expect(() => frappeSite('RESTODEMO', { ...base, MARKETPLACE_FRAPPE_RESTODEMO_URL: 'https://u:p@restodemo.konektag.eu/' })).toThrow('SITE_NOT_CONFIGURED');
    expect(frappeSite('RESTODEMO', { ...base, MARKETPLACE_FRAPPE_RESTODEMO_URL: 'https://restodemo.konektag.eu/' }).host).toBe('restodemo.konektag.eu');
  });

  it('sends the token only to its own site and maps Frappe failures', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: (init.headers as Record<string, string>).Authorization });
      if (String(url).includes('fail417')) return new Response(JSON.stringify({ exc_type: 'ValidationError', _server_messages: JSON.stringify([JSON.stringify({ message: '<b>Room 101</b> is already booked' })]) }), { status: 417 });
      if (String(url).includes('fail503')) return new Response('maintenance', { status: 503 });
      return new Response(JSON.stringify({ message: { name: 'ORD-1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const site = frappeSite('HOTELDEMO', { MARKETPLACE_FRAPPE_HOTELDEMO_URL: 'https://hoteldemo.konektag.eu/', MARKETPLACE_FRAPPE_HOTELDEMO_API_KEY: 'hk', MARKETPLACE_FRAPPE_HOTELDEMO_API_SECRET: 'hs' }, fetchImpl);
    await expect(site.call('x.ok', {})).resolves.toEqual({ name: 'ORD-1' });
    const rejected = await site.call('x.fail417', {}).catch(e => e);
    expect(rejected).toMatchObject({ code: 'SITE_REJECTED', httpStatus: 417, excType: 'ValidationError' });
    expect(rejected.serverMessage).toBe('Room 101 is already booked');
    await expect(site.call('x.fail503', {})).rejects.toMatchObject({ code: 'SITE_UNAVAILABLE' });
    await expect(site.call('../evil', {})).rejects.toThrow();
    expect(seen.every(s => s.url.startsWith('https://hoteldemo.konektag.eu/') && s.auth === 'token hk:hs')).toBe(true);
  });
});

// ── restaurant ───────────────────────────────────────────────────────────

describe('restaurant cart quote', () => {
  it('re-prices from the price list in effect today and reports changes', async () => {
    const t = setup();
    const res = await t.resto.quote(post(QUOTE_PATH, { currency: 'XAF', lines: [{ itemCode: 'BURGER', quantity: 2, unitPrice: 4000 }] }, null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines[0]).toMatchObject({ itemCode: 'BURGER', itemName: 'Burger maison', unitPrice: 4500, amount: 9000 });
    expect(body.priceChanges).toEqual([{ itemCode: 'BURGER', expectedUnitPrice: 4000, currentUnitPrice: 4500 }]);
    expect(body.total).toBe(9000);
  });

  it('flags disabled, unknown and out-of-section items as unavailable', async () => {
    const t = setup();
    const body = await (await t.resto.quote(post(QUOTE_PATH, { currency: 'XAF', lines: [
      { itemCode: 'OLD', quantity: 1, unitPrice: 100 }, { itemCode: 'TSHIRT', quantity: 1, unitPrice: 8000 }, { itemCode: 'NOPE', quantity: 1, unitPrice: 1 },
    ] }, null))).json();
    expect(body.unavailableItems).toEqual(['OLD', 'TSHIRT', 'NOPE']);
  });

  it('rejects a currency other than the outlet price list currency', async () => {
    const t = setup();
    const res = await t.resto.quote(post(QUOTE_PATH, { currency: 'EUR', lines: [{ itemCode: 'BURGER', quantity: 1, unitPrice: 4500 }] }, null));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('CURRENCY_MISMATCH');
  });

  it('refuses invalid quantities and unknown fields', async () => {
    const t = setup();
    for (const lines of [[{ itemCode: 'BURGER', quantity: 0, unitPrice: 4500 }], [{ itemCode: 'BURGER', quantity: 1.5, unitPrice: 4500 }], [{ itemCode: 'BURGER', quantity: 1, unitPrice: 4500, discount: 50 }]])
      expect((await t.resto.quote(post(QUOTE_PATH, { currency: 'XAF', lines }, null))).status).toBe(400);
  });
});

describe('restaurant order', () => {
  it('records a native Lumen order and returns the Frappe reference and status', async () => {
    const t = setup();
    const res = await t.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ reference: 'ORD-2026-00001', status: 'Open', currency: 'XAF', total: 10500, replayed: false });
    const [doc] = t.sites.RESTODEMO.table('POS Restaurant Order');
    expect(doc).toMatchObject({ pos_profile: 'Feane Brazzaville', app_type: 'Konektag', order_id: KEY, order_type: 'Takeaway' });
    expect(doc.note).toContain('+242061234567');
    expect(doc.items).toHaveLength(2);
  });

  it('requires an Idempotency-Key', async () => {
    const t = setup();
    const res = await t.resto.order(post(ORDER_PATH, order(), null));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the same submission without a second order', async () => {
    const t = setup();
    const first = await (await t.resto.order(post(ORDER_PATH, order()))).json();
    const again = await t.resto.order(post(ORDER_PATH, order()));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ reference: first.reference, replayed: true });
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(1);
  });

  it('finds the order in Lumen by its key when the replay cache is lost', async () => {
    const t = setup();
    const first = await (await t.resto.order(post(ORDER_PATH, order()))).json();
    t.store.data.clear();
    // Even with a price changed since, the replay returns the recorded order.
    t.sites.RESTODEMO.table('Item Price').find(p => p.item_code === 'FRITES')!.price_list_rate = 2000;
    const again = await (await t.resto.order(post(ORDER_PATH, order()))).json();
    expect(again.reference).toBe(first.reference);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(1);
  });

  it('resumes an order opened by an attempt that failed before saving its cart', async () => {
    const t = setup();
    t.sites.RESTODEMO.failNext['call:lumen_restaurants.api.restaurant.save_order'] = new FrappeSiteError('SITE_UNAVAILABLE', 504);
    const failed = await t.resto.order(post(ORDER_PATH, order()));
    expect(failed.status).toBe(503);
    const retry = await t.resto.order(post(ORDER_PATH, order()));
    expect(retry.status).toBe(201);
    expect((await retry.json()).reference).toBe('ORD-2026-00001');
    const orders = t.sites.RESTODEMO.table('POS Restaurant Order');
    expect(orders).toHaveLength(1);
    expect(orders[0].items).toHaveLength(2);
  });

  it('refuses the same key with another cart', async () => {
    const t = setup();
    await t.resto.order(post(ORDER_PATH, order()));
    const res = await t.resto.order(post(ORDER_PATH, order([{ itemCode: 'FRITES', quantity: 3, unitPrice: 1500 }])));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('answers REQUEST_IN_PROGRESS to a concurrent duplicate and writes once', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.resto.order(post(ORDER_PATH, order())), t.resto.order(post(ORDER_PATH, order()))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(1);
  });

  it('does not create an order when a price changed, and returns the fresh quote', async () => {
    const t = setup();
    t.sites.RESTODEMO.table('Item Price').find(p => p.item_code === 'FRITES')!.price_list_rate = 1800;
    const res = await t.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('PRICE_CHANGED');
    expect(body.quote.priceChanges).toEqual([{ itemCode: 'FRITES', expectedUnitPrice: 1500, currentUnitPrice: 1800 }]);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(0);
  });

  it('does not create an order with an unavailable dish', async () => {
    const t = setup();
    const res = await t.resto.order(post(ORDER_PATH, order([{ itemCode: 'OLD', quantity: 1, unitPrice: 100 }])));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ITEM_UNAVAILABLE');
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(0);
  });

  it('reports a closed outlet and a Frappe outage without leaking details', async () => {
    const t = setup();
    t.sites.RESTODEMO.table('POS Profile')[0].lumenpos_restaurant_mode = 0;
    expect((await (await t.resto.order(post(ORDER_PATH, order()))).json()).error).toBe('RESTAURANT_UNAVAILABLE');
    const t2 = setup();
    t2.sites.RESTODEMO.failNext['call:lumen_restaurants.api.restaurant.open_order'] = new FrappeSiteError('SITE_REJECTED', 403, 'PermissionError', 'You are not assigned to outlet');
    const res = await t2.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('assigned');
  });

  it('fails closed when Redis is unavailable', async () => {
    const t = setup();
    t.store.down = true;
    const res = await t.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(503);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(0);
  });

  it('rate limits one visitor phone', async () => {
    const t = setup();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await t.resto.order(post(ORDER_PATH, order(), `web-rate-limit-key-${String(i).padStart(4, '0')}`))).status;
    expect(last).toBe(429);
  });

  it('rejects the honeypot without recording anything', async () => {
    const t = setup();
    const res = await t.resto.order(post(ORDER_PATH, { ...order(), website: 'http://spam' }));
    expect(res.status).toBe(400);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(0);
  });
});

// ── hotel ────────────────────────────────────────────────────────────────

describe('hotel availability', () => {
  it('counts free rooms per type by dates and travellers, with the nightly rate', async () => {
    const t = setup();
    t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'HR-OLD', room: '101', status: 'Reserved', arrival_date: '2026-11-19', departure_date: '2026-11-21', guest: 'X' });
    const res = await t.hotel.availability(get(AV_PATH + '?arrival=2026-11-20&departure=2026-11-22&adults=2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nights).toBe(2);
    expect(body.roomTypes).toEqual([
      expect.objectContaining({ roomType: 'Standard', available: true, availableRooms: 1, nightlyRate: 35000, total: 70000, currency: 'XAF' }),
      expect.objectContaining({ roomType: 'Suite', available: false, availableRooms: 0 }),
    ]);
    expect(JSON.stringify(body)).not.toContain('101');
  });

  it('treats checked-out and cancelled stays and back-to-back dates as free', async () => {
    const t = setup();
    t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'A', room: '101', status: 'Checked Out', arrival_date: '2026-11-20', departure_date: '2026-11-22' });
    t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'B', room: '102', status: 'Reserved', arrival_date: '2026-11-18', departure_date: '2026-11-20' });
    const body = await (await t.hotel.availability(get(AV_PATH + '?arrival=2026-11-20&departure=2026-11-22&adults=1'))).json();
    expect(body.roomTypes[0].availableRooms).toBe(2);
  });

  it('does not offer a room type that cannot host the travellers', async () => {
    const t = setup();
    const body = await (await t.hotel.availability(get(AV_PATH + '?arrival=2026-11-20&departure=2026-11-22&adults=3'))).json();
    expect(body.roomTypes.find((r: any) => r.roomType === 'Standard').available).toBe(false);
  });

  it('rejects past, inverted, too long and malformed stays', async () => {
    const t = setup();
    for (const q of ['arrival=2026-11-01&departure=2026-11-03&adults=1', 'arrival=2026-11-22&departure=2026-11-20&adults=1',
      'arrival=2026-11-20&departure=2027-01-20&adults=1', 'arrival=2026-02-30&departure=2026-03-02&adults=1', 'arrival=2026-11-20&departure=2026-11-22&adults=0'])
      expect((await t.hotel.availability(get(AV_PATH + '?' + q))).status).toBe(400);
  });
});

describe('hotel reservation', () => {
  it('books a free room in Hospitality and returns its reference and business status', async () => {
    const t = setup();
    const res = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ reference: 'HR-2026-00001', status: 'Reserved', roomType: 'Standard', nights: 2, total: 70000, currency: 'XAF', replayed: false });
    const [doc] = t.sites.HOTELDEMO.table('Hotel Reservation');
    expect(doc).toMatchObject({ room: '101', hotel_reception: 'Réception', guest: 'Jean Ngoma', status: 'Reserved' });
  });

  it('replays the same submission without a second reservation', async () => {
    const t = setup();
    const first = await (await t.hotel.reserve(post(RES_PATH, booking()))).json();
    const again = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(again.status).toBe(200);
    expect((await again.json()).reference).toBe(first.reference);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(1);
  });

  it('finds a reservation Frappe accepted before the connection dropped', async () => {
    const t = setup();
    t.sites.HOTELDEMO.failNext['after:Hotel Reservation'] = new FrappeSiteError('SITE_UNAVAILABLE');
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(503);
    const retry = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(retry.status).toBe(201);
    expect((await retry.json()).reference).toBe('HR-2026-00001');
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(1);
  });

  it('reports a room lost between search and validation with fresh availability', async () => {
    const t = setup();
    // Both rooms are taken at the desk after the visitor searched.
    for (const room of ['101', '102'])
      t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'DESK-' + room, room, status: 'Reserved', arrival_date: '2026-11-21', departure_date: '2026-11-23' });
    const res = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ROOM_UNAVAILABLE');
    expect(body.availability.roomTypes[0]).toMatchObject({ roomType: 'Standard', available: false });
  });

  it('moves to the next free room when Hospitality refuses the first one at insert', async () => {
    const t = setup();
    t.sites.HOTELDEMO.failNext['insert:Hotel Reservation'] = new FrappeSiteError('SITE_REJECTED', 417, 'ValidationError', 'Room 101 is already booked by X');
    const res = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(res.status).toBe(201);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')[0].room).toBe('102');
  });

  it('never double-books the last room for two concurrent visitors', async () => {
    const t = setup();
    t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'DESK', room: '101', status: 'Reserved', arrival_date: '2026-11-20', departure_date: '2026-11-22' });
    const [a, b] = await Promise.all([
      t.hotel.reserve(post(RES_PATH, booking(), 'web-hotel-visitor-a-000001')),
      t.hotel.reserve(post(RES_PATH, booking({ guest: { fullName: 'Marie Okemba', phone: '+242055555555' } }), 'web-hotel-visitor-b-000001')),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation').filter(r => r.room === '102')).toHaveLength(1);
  });

  it('refuses a changed total, a wrong currency and too many travellers', async () => {
    const t = setup();
    const price = await t.hotel.reserve(post(RES_PATH, booking({ expectedTotal: 60000 }), 'web-hotel-price-0000000001'));
    expect(price.status).toBe(409);
    expect((await price.json()).error).toBe('PRICE_CHANGED');
    const currency = await t.hotel.reserve(post(RES_PATH, booking({ currency: 'EUR' }), 'web-hotel-curr-00000000001'));
    expect((await currency.json()).error).toBe('CURRENCY_MISMATCH');
    const crowd = await t.hotel.reserve(post(RES_PATH, booking({ adults: 3 }), 'web-hotel-crowd-0000000001'));
    expect((await crowd.json()).error).toBe('OCCUPANCY_EXCEEDED');
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(0);
  });

  it('reuses a known guest and disambiguates a namesake', async () => {
    const t = setup();
    t.sites.HOTELDEMO.add('Guest', { name: 'Jean Ngoma', full_name: 'Jean Ngoma', mobile_no: '+242000000000' });
    await t.hotel.reserve(post(RES_PATH, booking()));
    const guests = t.sites.HOTELDEMO.table('Guest');
    expect(guests).toHaveLength(2);
    expect(guests[1].name).toMatch(/^Jean Ngoma \(/);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')[0].guest).toBe(guests[1].name);
  });
});
