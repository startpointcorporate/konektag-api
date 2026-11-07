import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { FrappeSiteError, frappeSite, type FrappeSite, type Filter } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
import * as quoteRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/quote.ts';
import * as orderRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import * as menuRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/menu.ts';
import * as availabilityRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/availability.ts';
import * as reservationRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/reservations.ts';
import * as roomsRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/rooms.ts';
import * as profileRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/index.ts';
import type { RequestContext } from '../../src/api/http.ts';

// The Marketplace route handlers, with injected dependencies.
type Ctx = RequestContext;
const restaurantHandlers = (deps: TransactionDeps) => ({ quote: (c: Ctx) => quoteRoute.POST(c, deps), order: (c: Ctx) => orderRoute.POST(c, deps) });
const hotelHandlers = (deps: TransactionDeps) => ({ availability: (c: Ctx) => availabilityRoute.GET(c, deps), reserve: (c: Ctx) => reservationRoute.POST(c, deps) });
const catalogueHandlers = (deps: TransactionDeps) => ({ menu: (c: Ctx) => menuRoute.GET(c, deps), rooms: (c: Ctx) => roomsRoute.GET(c, deps) });
const profileHandler = (deps: TransactionDeps) => (c: Ctx) => profileRoute.GET(c, deps);
import { ProjectionUnavailable, sqlPublishedProfiles, toPublicProfile, type ProjectionRow, type PublishedProfiles } from '../../src/application/marketplace-transactions/published-profiles.ts';
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
    case '>=': return v >= (value as any);
    case '<=': return v <= (value as any);
    default: throw new Error('op ' + op);
  }
}

/** In-memory Frappe site applying the Lumen and Hospitality rules we rely on. */
class FakeSite implements FrappeSite {
  docs = new Map<string, any[]>();
  calls: string[] = [];
  seq = 0;
  failNext: Record<string, Error> = {};
  uniqueRef?: string;
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
      // Unique index on the external reference (konektag_360#14), when the site has the field.
      if (this.uniqueRef && doc[this.uniqueRef] && this.table('Hotel Reservation').some(r => r[this.uniqueRef!] === doc[this.uniqueRef!]))
        throw new FrappeSiteError('SITE_REJECTED', 409, 'DuplicateEntryError');
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

const REF = 'konektag_reference';
const envWithRef = {
  MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
    'hotelier-brazzaville': { hotel: { site: 'HOTELDEMO', currency: 'XAF', externalReferenceField: REF } },
  }),
} as NodeJS.ProcessEnv;

/** konektag_360.domain.snapshot() shape, as delivered to the projection. */
function snapshotOf(slug: string, name: string) {
  return {
    establishment_id: '9b1d4c7e-0000-4000-8000-000000000001', establishment_name: name, description: 'Cuisine maison',
    country_code: 'CG', city_id: 'cg-bzv', city_name: 'Brazzaville', city_slug: 'brazzaville', address: 'Avenue Foch',
    latitude: '-4.2634', longitude: '15.2429', slug,
    merchant: { merchant_id: 'm-1', merchant_name: 'Groupe Démo', description: null, logo: '/files/logo.png', website: 'https://demo.example',
      public_email: 'contact@demo.example', public_phone: '+242060000001', seo_title: null, seo_description: null },
    activities: [{ activity_code: 'restaurant', activity_name: 'Restaurant' }],
    opening_hours: [{ weekday: 'Monday', closed: 1, opens_at: null, closes_at: null }, { weekday: 'Tuesday', closed: 0, opens_at: '11:00:00', closes_at: '22:30:00' }],
    media: [{ file: '/files/salle.jpg', alt_text: 'Salle', caption: null }, { file: 'https://evil.example/x.jpg', alt_text: 'x', caption: null }],
    social_links: [{ platform: 'Instagram', url: 'https://instagram.com/demo' }, { platform: 'Bad', url: 'javascript:alert(1)' }],
  };
}
const row = (slug: string, capabilities: string[], status: 'Published' | 'Unpublished' = 'Published'): ProjectionRow => ({
  establishment_id: '9b1d4c7e-0000-4000-8000-000000000001', source_site: 'congo.erp.konektag.eu', slug, publication_version: 3,
  status, snapshot: status === 'Published' ? snapshotOf(slug, 'Feane') : null, capabilities: status === 'Published' ? capabilities : [],
  delivered_at: '2026-11-06T09:00:00Z',
});
class MemoryProjection implements PublishedProfiles {
  rows = new Map<string, ProjectionRow>([
    ['feane-brazzaville', row('feane-brazzaville', ['restaurant'])],
    ['hotelier-brazzaville', row('hotelier-brazzaville', ['hotel'])],
    ['boutique-standard', row('boutique-standard', [])],
  ]);
  down = false;
  async bySlug(slug: string) { if (this.down) throw new ProjectionUnavailable(); return this.rows.get(slug) ?? null; }
}

function setup(withRef = false) {
  const projection = new MemoryProjection();
  const store = new MemoryStore();
  const sites: Record<string, FakeSite> = { RESTODEMO: restaurantSite(), HOTELDEMO: hotelSite() };
  if (withRef) sites.HOTELDEMO.uniqueRef = REF;
  const used: string[] = [];
  const deps: TransactionDeps = { store: () => store, site: key => { used.push(key); return sites[key]; }, profiles: () => projection, env: withRef ? envWithRef : env, now: () => NOW };
  return { store, sites, used, projection, resto: restaurantHandlers(deps), hotel: hotelHandlers(deps), profile: profileHandler(deps), catalogue: catalogueHandlers(deps) };
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

  // A booking that matches the same guest, room type and dates but is not ours.
  const decoy = (site: FakeSite) => {
    site.add('Guest', { name: 'Jean Ngoma', full_name: 'Jean Ngoma', email_id: 'jean@example.com', mobile_no: '+242069876543' });
    site.add('Hotel Reservation', { name: 'HR-DESK-0001', guest: 'Jean Ngoma', room_type: 'Standard', room: '102', status: 'Reserved', arrival_date: '2026-11-20', departure_date: '2026-11-22' });
  };

  it('reports an unknown outcome after an interrupted write instead of returning a look-alike booking', async () => {
    const t = setup();
    decoy(t.sites.HOTELDEMO);
    t.sites.HOTELDEMO.failNext['after:Hotel Reservation'] = new FrappeSiteError('SITE_UNAVAILABLE');
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(503);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(2); // decoy + ours, landed before the cut
    for (let i = 0; i < 2; i++) {
      const retry = await t.hotel.reserve(post(RES_PATH, booking()));
      expect(retry.status).toBe(409);
      const body = await retry.json();
      expect(body.error).toBe('RESERVATION_OUTCOME_UNKNOWN');
      expect(JSON.stringify(body)).not.toContain('HR-');
    }
    // No second booking, and the desk booking was never claimed as ours.
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(2);
  });

  it('retries normally after a clean refusal, which wrote nothing', async () => {
    const t = setup();
    for (const room of ['101', '102'])
      t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'DESK-' + room, room, status: 'Reserved', arrival_date: '2026-11-21', departure_date: '2026-11-23' });
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(409);
    t.sites.HOTELDEMO.table('Hotel Reservation').find(r => r.name === 'DESK-101')!.status = 'Cancelled';
    const retry = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(retry.status).toBe(201);
  });

  it('resumes by the unique external reference only, ignoring a look-alike booking', async () => {
    const t = setup(true);
    decoy(t.sites.HOTELDEMO);
    t.sites.HOTELDEMO.failNext['after:Hotel Reservation'] = new FrappeSiteError('SITE_UNAVAILABLE');
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(503);
    const ours = t.sites.HOTELDEMO.table('Hotel Reservation').find(r => r[REF] === KEY)!;
    expect(ours.name).not.toBe('HR-DESK-0001');
    const retry = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(retry.status).toBe(201);
    expect((await retry.json()).reference).toBe(ours.name);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(2);
  });

  it('books once when the interrupted attempt never reached Hospitality', async () => {
    const t = setup(true);
    t.sites.HOTELDEMO.failNext['insert:Hotel Reservation'] = new FrappeSiteError('SITE_UNAVAILABLE');
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(503);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation')).toHaveLength(0);
    const retry = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(retry.status).toBe(201);
    expect(t.sites.HOTELDEMO.table('Hotel Reservation').filter(r => r[REF] === KEY)).toHaveLength(1);
  });

  it('turns a duplicate external reference into the recorded booking', async () => {
    const t = setup(true);
    // Our first attempt landed late, after the replay cache was lost.
    t.sites.HOTELDEMO.add('Hotel Reservation', { name: 'HR-2026-00099', [REF]: KEY, guest: 'Jean Ngoma', room_type: 'Standard', room: '101', status: 'Reserved', arrival_date: '2026-11-20', departure_date: '2026-11-22' });
    const res = await t.hotel.reserve(post(RES_PATH, booking()));
    expect(res.status).toBe(201);
    expect((await res.json()).reference).toBe('HR-2026-00099');
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

// ── Marketplace read (API #24) and published-capability gate ─────────────

describe('published profile read', () => {
  const PROFILE = '/api/public/marketplace/merchants/feane-brazzaville';

  it('serves a published profile with public fields only and absolute public media', async () => {
    const t = setup();
    const res = await t.profile(get(PROFILE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      slug: 'feane-brazzaville', name: 'Feane', merchantName: 'Groupe Démo', countryCode: 'CG', version: 3,
      city: { id: 'cg-bzv', name: 'Brazzaville', slug: 'brazzaville' }, coordinates: { lat: -4.2634, lng: 15.2429 },
      logo: { url: 'https://congo.erp.konektag.eu/files/logo.png' }, capabilities: ['restaurant'],
    });
    expect(body.media).toEqual([{ url: 'https://congo.erp.konektag.eu/files/salle.jpg', alt: 'Salle' }]);
    expect(body.socialLinks).toEqual([{ platform: 'Instagram', url: 'https://instagram.com/demo' }]);
    expect(body.openingHours).toEqual([{ day: 1, closed: true }, { day: 2, closed: false, opens: '11:00', closes: '22:30' }]);
    expect(JSON.stringify(body)).not.toMatch(/merchant_id|evil|javascript/);
  });

  it('answers 404 for an absent, unpublished or malformed slug', async () => {
    const t = setup();
    t.projection.rows.set('feane-brazzaville', row('feane-brazzaville', [], 'Unpublished'));
    for (const path of [PROFILE, '/api/public/marketplace/merchants/inconnu', '/api/public/marketplace/merchants/Bad_Slug']) {
      const res = await t.profile(get(path));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'PROFILE_NOT_FOUND' });
    }
  });

  it('reports the projection as unavailable rather than missing', async () => {
    const t = setup();
    t.projection.down = true;
    const res = await t.profile(get(PROFILE));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('PROFILE_SOURCE_UNAVAILABLE');
  });

  it('reads the projection with one parameterised SELECT and hides database errors', async () => {
    const calls: unknown[][] = [];
    const reader = sqlPublishedProfiles(async (text, params) => { calls.push([text, params]); return { rows: [] }; });
    expect(await reader.bySlug("x' OR 1=1 --")).toBeNull();
    expect(String(calls[0][0])).toMatch(/^SELECT .* FROM konektag\.marketplace_published_establishments WHERE slug = \$1$/s);
    expect(calls[0][1]).toEqual(["x' OR 1=1 --"]);
    const broken = sqlPublishedProfiles(async () => { throw new Error('password authentication failed'); });
    await expect(broken.bySlug('a')).rejects.toBeInstanceOf(ProjectionUnavailable);
  });

  it('drops coordinates that are absent rather than zero', () => {
    const r = row('feane-brazzaville', []);
    r.snapshot.latitude = null; r.snapshot.longitude = null;
    expect(toPublicProfile(r).coordinates).toBeUndefined();
  });
});

describe('transactions require a published capability', () => {
  it('refuses an order when the profile is unpublished, without calling Frappe', async () => {
    const t = setup();
    t.projection.rows.set('feane-brazzaville', row('feane-brazzaville', [], 'Unpublished'));
    const res = await t.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CAPABILITY_NOT_AVAILABLE');
    expect(t.used).toEqual([]);
  });

  it('never calls Lumen when the published profile lacks the restaurant capability, even if configured', async () => {
    const t = setup();
    t.projection.rows.set('feane-brazzaville', row('feane-brazzaville', ['hotel']));
    expect((await t.resto.quote(post(QUOTE_PATH, { currency: 'XAF', lines: [{ itemCode: 'BURGER', quantity: 1, unitPrice: 4500 }] }, null))).status).toBe(404);
    expect((await t.resto.order(post(ORDER_PATH, order()))).status).toBe(404);
    expect((await t.catalogue.menu(get('/api/public/marketplace/merchants/feane-brazzaville/restaurant/menu'))).status).toBe(404);
    expect(t.used).toEqual([]);
    expect(t.sites.RESTODEMO.calls).toEqual([]);
  });

  it('refuses a booking when the hotel capability is not published, even if configured', async () => {
    const t = setup();
    t.projection.rows.set('hotelier-brazzaville', row('hotelier-brazzaville', ['restaurant']));
    expect((await t.hotel.reserve(post(RES_PATH, booking()))).status).toBe(404);
    expect((await t.hotel.availability(get(AV_PATH + '?arrival=2026-11-20&departure=2026-11-22&adults=1'))).status).toBe(404);
    expect(t.used).toEqual([]);
  });

  it('refuses a published capability that has no server-side routing', async () => {
    const t = setup();
    t.projection.rows.set('boutique-standard', row('boutique-standard', ['restaurant']));
    expect((await t.resto.order(post('/api/public/marketplace/merchants/boutique-standard/restaurant/orders', order()))).status).toBe(404);
  });

  it('fails closed when the projection is down', async () => {
    const t = setup();
    t.projection.down = true;
    const res = await t.resto.order(post(ORDER_PATH, order()));
    expect(res.status).toBe(503);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(0);
  });
});

describe('live catalogues', () => {
  it('lists orderable dishes of the outlet sections with today\'s prices, as the order validation accepts them', async () => {
    const t = setup();
    const res = await t.catalogue.menu(get('/api/public/marketplace/merchants/feane-brazzaville/restaurant/menu'));
    expect(res.status).toBe(200);
    const menu = await res.json();
    expect(menu.currency).toBe('XAF');
    expect(menu.sections).toEqual([{ name: 'Plats', dishes: [
      { itemCode: 'BURGER', name: 'Burger maison', price: 4500 },
      { itemCode: 'FRITES', name: 'Frites', price: 1500 },
    ] }]);
    // Every dish on the menu is accepted at its displayed price.
    const lines = menu.sections.flatMap((s: any) => s.dishes.map((d: any) => ({ itemCode: d.itemCode, quantity: 1, unitPrice: d.price })));
    const quote = await (await t.resto.quote(post(QUOTE_PATH, { currency: menu.currency, lines }, null))).json();
    expect(quote.priceChanges).toEqual([]);
    expect(quote.unavailableItems).toEqual([]);
  });

  it('lists bookable room types without room numbers', async () => {
    const t = setup();
    const res = await t.catalogue.rooms(get('/api/public/marketplace/merchants/hotelier-brazzaville/hotel/rooms'));
    const body = await res.json();
    expect(body.roomTypes.map((r: any) => r.roomType)).toEqual(['Standard']); // the only Suite is Out of Order
    expect(JSON.stringify(body)).not.toContain('101');
  });

  it('hides catalogues of unpublished capabilities', async () => {
    const t = setup();
    expect((await t.catalogue.menu(get('/api/public/marketplace/merchants/hotelier-brazzaville/restaurant/menu'))).status).toBe(404);
    expect((await t.catalogue.rooms(get('/api/public/marketplace/merchants/feane-brazzaville/hotel/rooms'))).status).toBe(404);
  });
});

describe('JSON body cap (2 MiB)', () => {
  const MIB2 = 2_097_152;
  /** A streamed body with no Content-Length, produced lazily in 64 KiB chunks. */
  function streamed(path: string, total: number, head = '{"currency":"XAF","note":"', fill = 'a') {
    let sent = 0;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) { c.close(); return; }
        const text = sent === 0 ? head + fill.repeat(Math.min(65_536, total) - head.length) : fill.repeat(Math.min(65_536, total - sent));
        sent += text.length;
        c.enqueue(enc.encode(text));
      },
    });
    const request = new Request('https://api.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': KEY }, body, duplex: 'half' } as RequestInit);
    return { ctx: createContext(request, { slug: path.split('/')[5] }, '10.0.0.5'), pulled: () => sent, request };
  }

  it('accepts a valid order larger than the former 16 KB limit', async () => {
    const t = setup();
    const raw = ' '.repeat(20_000) + JSON.stringify({ ...order(), note: 'Sans oignons. '.repeat(35) });
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(16_384);
    const ctx = createContext(new Request('https://api.test' + ORDER_PATH, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': KEY }, body: raw }), { slug: 'feane-brazzaville' }, '10.0.0.5');
    const res = await t.resto.order(ctx);
    expect(res.status).toBe(201);
    expect(t.sites.RESTODEMO.table('POS Restaurant Order')).toHaveLength(1);
  });

  it('rejects more than 2 MiB without Content-Length before parsing or any Frappe call', async () => {
    for (const [path, call] of [[ORDER_PATH, 'order'], [QUOTE_PATH, 'quote'], [RES_PATH, 'reserve']] as const) {
      const t = setup();
      const s = streamed(path, 3 * 1024 * 1024);
      expect(s.request.headers.get('content-length')).toBeNull();
      const res = call === 'reserve' ? await t.hotel.reserve(s.ctx) : await t.resto[call](s.ctx);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
      expect(t.used).toEqual([]); // no Lumen or Hospitality site touched
      expect(s.pulled()).toBeLessThanOrEqual(MIB2 + 2 * 65_536); // stopped reading at the cap
    }
  });

  it('counts the bytes read: exactly 2 MiB passes the cap, one more byte does not', async () => {
    const t = setup();
    const valid = JSON.stringify({ currency: 'XAF', lines: [{ itemCode: 'BURGER', quantity: 1, unitPrice: 4500 }] });
    const at = streamed(QUOTE_PATH, MIB2, ' ', ' ');
    const padded = ' '.repeat(MIB2 - valid.length) + valid;
    const exact = createContext(new Request('https://api.test' + QUOTE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: padded }), { slug: 'feane-brazzaville' }, '10.0.0.5');
    expect((await t.resto.quote(exact)).status).toBe(200);
    expect((await t.resto.quote(streamed(QUOTE_PATH, MIB2 + 1, ' ', ' ').ctx)).status).toBe(413);
    expect((await t.resto.quote(at.ctx)).status).toBe(400); // within the cap, then refused as invalid JSON
  });

  it('refuses a declared Content-Length above the cap without reading the body', async () => {
    const t = setup();
    const s = streamed(ORDER_PATH, 3 * 1024 * 1024);
    const ctx = createContext(new Request(s.request, { headers: { 'content-type': 'application/json', 'idempotency-key': KEY, 'content-length': String(MIB2 + 1) } }), { slug: 'feane-brazzaville' }, '10.0.0.5');
    expect((await t.resto.order(ctx)).status).toBe(413);
    expect(s.pulled()).toBeLessThan(MIB2); // the runtime may prefetch a few chunks; the API reads none
    expect(t.used).toEqual([]);
  });
});
