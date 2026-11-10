/**
 * Unified Frappe routing of the Konektag journeys:
 * residence country -> payment_country_mappings -> konektag-<country> -> Frappe site.
 * A fake Frappe per host records every call, so each test proves the site actually used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), checkRateLimit: vi.fn(), sendMeetingReceipt: vi.fn(), send: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: { checkRateLimit: m.checkRateLimit } }));
vi.mock('../../src/application/shared/meeting-receipt.ts', () => ({ sendMeetingReceipt: m.sendMeetingReceipt }));
vi.mock('../../src/application/services/resend-service.ts', () => ({ emailService: { send: m.send } }));

import { createContext } from '../../src/api/http';
import { KonektagSiteError, resolveKonektagSite } from '../../src/application/shared/konektag-site.ts';
import { loadCapabilities } from '../../src/application/marketplace-transactions/merchant-capabilities.ts';
import { GET as meetingSlots } from '../../src/api/routes/meeting-slots.ts';
import { POST as meetingRequest } from '../../src/api/routes/meeting-request.ts';
import { POST as commercialRequest } from '../../src/api/routes/public/commercial-request.ts';
import { POST as recharges } from '../../src/api/routes/pay/recharges.ts';
import { GET as paymentContextRoute } from '../../src/api/routes/pay/payment-context.ts';
import { ErpnextContactService } from '../../src/application/services/erpnext-contact-service.ts';
import { apiPaymentCheckoutService } from '../../src/application/services/pay/api-payment-checkout-service.ts';
import { verifyPaymentContextSelection } from '../../src/application/services/pay/payment-context-resolver.ts';

// Rules after migration 231 (BE -> FR as in migration 118).
const rules: Record<string, string> = { BE: 'FR', FR: 'FR', CG: 'CG', CM: 'CG', LB: 'LB' };
const merchants = {
  'konektag-fr': { site: 'EUROPE' },
  'konektag-cg': { site: 'CONGO' },
  'konektag-lb': { site: 'LIBAN' },
  'le-jardin': { restaurant: { site: 'RESTODEMO', posProfile: 'POS' } },
};
const hosts: Record<string, string> = { EUROPE: 'europe.erp.konektag.eu', CONGO: 'congo.erp.konektag.eu', LIBAN: 'liban.erp.konektag.eu' };
const currencies: Record<string, { country: string; currency: string; fee: number }> = {
  'europe.erp.konektag.eu': { country: 'France', currency: 'EUR', fee: 290 },
  'congo.erp.konektag.eu': { country: 'Congo', currency: 'XAF', fee: 150 },
  'liban.erp.konektag.eu': { country: 'Lebanon', currency: 'USD', fee: 350 },
};

type Call = { host: string; method: string; doctype: string };
let calls: Call[];
let docs: Map<string, any[]>;
let seq: number;
const saved = { ...process.env };

function table(host: string, doctype: string) {
  const key = host + '|' + doctype;
  if (!docs.has(key)) docs.set(key, []);
  return docs.get(key)!;
}

/** Minimal Frappe REST: resource list/get/insert/update with "=" filters, plus the payment master data. */
async function fakeFrappe(input: URL | string, init: RequestInit = {}) {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const [, , kind, rawDoctype, rawName] = url.pathname.split('/');
  const doctype = decodeURIComponent(rawDoctype ?? '');
  const name = rawName ? decodeURIComponent(rawName) : null;
  calls.push({ host: url.hostname, method, doctype });
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 });
  if (kind !== 'resource') return new Response('{}', { status: 404 });
  const pay = currencies[url.hostname];
  if (doctype === 'Konektag Legal Entity') return ok([{ name: 'KTG', entity_code: 'KTG-' + pay.currency, entity_name: 'Konektag ' + pay.country, country: pay.country, currency: pay.currency, status: 'Approved' }]);
  if (doctype === 'Konektag Regulatory Profile') return ok([{ name: 'P', profile_code: 'LINK-' + pay.currency, legal_entity: 'KTG', corridor: 'C', runtime_operation: 'link_payment', rail: 'stripe', runtime_provider: 'stripe', provider_configuration_key: 'KTG_' + pay.currency.slice(0, 2) + '_STRIPE_TEST', runtime_actor_code: 'A', status: 'Approved', valid_from: '2020-01-01', valid_until: null, fee_percentage_bps: pay.fee, fee_fixed_amount: 0 }]);
  if (doctype === 'Konektag Corridor') return ok({ name: 'C', corridor_code: 'C', origin_entity: 'KTG', destination_entity: 'KTG', status: 'Approved' });
  if (doctype === 'Konektag Regulated Actor') return ok({ name: 'A', actor_code: 'A', actor_name: 'Stripe', status: 'Approved' });
  if (doctype === 'Appointment Booking Settings') return ok({
    enable_scheduling: 1, appointment_duration: 30, number_of_agents: 1, advance_booking_days: 30, holiday_list: 'H',
    agent_list: [{ user: 'agent@' + url.hostname }],
    availability_of_slots: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      .map(day_of_week => ({ day_of_week, from_time: url.hostname.startsWith('europe') ? '09:00:00' : '14:00:00', to_time: url.hostname.startsWith('europe') ? '10:00:00' : '15:00:00' })),
  });
  if (doctype === 'Holiday List') return ok({ holidays: [] });
  const rows = table(url.hostname, doctype);
  if (method === 'GET' && !name) {
    const filters = JSON.parse(url.searchParams.get('filters') ?? '[]') as Array<[string, string, unknown]>;
    return ok(rows.filter(r => filters.every(([f, op, v]) => op !== '=' || r[f] === v)));
  }
  if (method === 'POST') {
    const doc = { ...JSON.parse(String(init.body)), name: doctype.toUpperCase() + '-' + (++seq) };
    rows.push(doc);
    return ok(doc);
  }
  if (method === 'PUT' && name) {
    const doc = rows.find(r => r.name === name);
    Object.assign(doc, JSON.parse(String(init.body)));
    return ok(doc);
  }
  return new Response('{}', { status: 404 });
}

/** Payment rules and users from PostgreSQL. */
function database(users: Record<string, string> = {}) {
  m.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('payment_country_mappings')) {
      const rule = rules[String(values[0])];
      return { rows: rule ? [{ payment_country: rule }] : [] };
    }
    if (sql.includes('FROM konektag.users')) {
      const country = users[String(values[0])];
      return { rows: country ? [{ username: 'ada', legal_country: country }] : [] };
    }
    if (sql.includes('legal_consents')) return { rows: [{ accepted_at: '2026-11-10T08:00:00Z', legal_country: 'BE', accepted: true, terms_version: 't1', privacy_version: 'p1' }] };
    if (sql.includes('INSERT INTO konektag.api_payment_orders')) return { rows: [{ id: 'order-1', state: 'pending', environment: 'live', order_metadata: JSON.parse(String(values[7])), currency: values[3], total_amount: values[4], payment_country: values[6] }] };
    return { rows: [] };
  });
}

const sitesCalled = () => [...new Set(calls.map(c => c.host))];

beforeEach(() => {
  calls = []; docs = new Map(); seq = 0;
  vi.resetAllMocks();
  process.env.MARKETPLACE_TRANSACTION_MERCHANTS = JSON.stringify(merchants);
  for (const [site, host] of Object.entries(hosts)) {
    process.env[`MARKETPLACE_FRAPPE_${site}_URL`] = `https://${host}/`;
    process.env[`MARKETPLACE_FRAPPE_${site}_API_KEY`] = 'key-' + site;
    process.env[`MARKETPLACE_FRAPPE_${site}_API_SECRET`] = 'secret-' + site;
  }
  for (const c of ['FR', 'CG', 'LB']) process.env[`KONEKTAG_MEETING_${c}_LEAD_OWNER`] = 'owner-' + c.toLowerCase() + '@konektag.eu';
  process.env.RESEND_API_KEY = 'test';
  process.env.KONEKTAG_INTEGRATION_SECRET = 'routing-selection-secret-0123456789abcdef';
  delete process.env.TURNSTILE_SECRET_KEY;
  m.checkRateLimit.mockResolvedValue(true);
  m.sendMeetingReceipt.mockResolvedValue(true);
  m.send.mockResolvedValue(true);
  database();
  vi.stubGlobal('fetch', vi.fn(fakeFrappe));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('resolveKonektagSite', () => {
  it.each([
    ['BE', 'FR', 'konektag-fr', 'EUROPE', 'Europe/Paris'],
    ['CG', 'CG', 'konektag-cg', 'CONGO', 'Africa/Brazzaville'],
    ['LB', 'LB', 'konektag-lb', 'LIBAN', 'Asia/Beirut'],
    ['cm', 'CG', 'konektag-cg', 'CONGO', 'Africa/Brazzaville'],
  ])('%s -> %s -> %s -> %s', async (residence, paymentCountry, slug, site, timezone) => {
    await expect(resolveKonektagSite(residence)).resolves.toEqual({
      residenceCountry: residence.toUpperCase(), paymentCountry, slug, site, timezone,
    });
    const [sql, values] = m.query.mock.calls[0];
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain('valid_from <= CURRENT_DATE');
    expect(values).toEqual([residence.toUpperCase()]);
  });

  it('fails explicitly on a missing rule, a rule outside FR/CG/LB, an ambiguous rule and a missing site', async () => {
    await expect(resolveKonektagSite('US')).rejects.toMatchObject({ code: 'COUNTRY_RULE_NOT_FOUND' });
    await expect(resolveKonektagSite('Belgique')).rejects.toMatchObject({ code: 'RESIDENCE_COUNTRY_INVALID' });
    m.query.mockResolvedValueOnce({ rows: [{ payment_country: 'GA' }] });
    await expect(resolveKonektagSite('GA')).rejects.toMatchObject({ code: 'COUNTRY_RULE_OUTSIDE_KONEKTAG' });
    m.query.mockResolvedValueOnce({ rows: [{ payment_country: 'FR' }, { payment_country: 'CG' }] });
    await expect(resolveKonektagSite('BE')).rejects.toMatchObject({ code: 'COUNTRY_RULE_AMBIGUOUS' });
    process.env.MARKETPLACE_TRANSACTION_MERCHANTS = JSON.stringify({ 'konektag-fr': { site: 'EUROPE' } });
    await expect(resolveKonektagSite('LB')).rejects.toBeInstanceOf(KonektagSiteError);
    await expect(resolveKonektagSite('LB')).rejects.toMatchObject({ code: 'KONEKTAG_SITE_NOT_CONFIGURED', detail: { slug: 'konektag-lb' } });
  });

  it('keeps the restaurant and hotel entries of the same configuration valid', () => {
    const config = loadCapabilities();
    expect(config['konektag-fr']).toEqual({ site: 'EUROPE' });
    expect(config['le-jardin'].restaurant).toMatchObject({ site: 'RESTODEMO', posProfile: 'POS' });
  });
});

/** Tomorrow in the entity calendar, inside the advance booking window. */
function tomorrow() { return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); }
const post = (path: string, body: unknown) => createContext(new Request('https://api.konektag.eu' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

describe('Présenter mon projet', () => {
  it.each([['Belgique', 'europe.erp.konektag.eu', 'konektag-fr', 'owner-fr@konektag.eu'], ['LB', 'liban.erp.konektag.eu', 'konektag-lb', 'owner-lb@konektag.eu']])(
    'creates the Lead of a %s resident on %s', async (country, host, slug, owner) => {
      const response = await commercialRequest(post('/api/public/commercial-request', {
        kind: 'contact', locale: 'fr', name: 'Ada Test', company: 'Ada SARL', email: 'ada@example.invalid', country, message: 'Mon projet',
      }));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ ok: true, konektagSite: slug });
      expect(sitesCalled()).toEqual([host]);
      expect(table(host, 'Lead')).toEqual([expect.objectContaining({ email_id: 'ada@example.invalid', lead_owner: owner })]);
    });

  it('updates the existing Lead on the routed site instead of creating one', async () => {
    table('europe.erp.konektag.eu', 'Lead').push({ name: 'LEAD-1', email_id: 'ada@example.invalid', custom_activity_summary: 'avant' });
    const response = await commercialRequest(post('/api/public/commercial-request', {
      kind: 'contact', locale: 'fr', name: 'Ada Test', company: 'Ada SARL', email: 'ada@example.invalid', country: 'BE', message: 'Mon projet',
    }));
    expect(await response.json()).toMatchObject({ reference: 'LEAD-1' });
    expect(calls.filter(c => c.doctype === 'Lead').map(c => c.method)).toEqual(['GET', 'PUT']);
  });

  it('refuses an unknown country or a country without rule, without calling Frappe', async () => {
    for (const [country, error] of [['Atlantide', 'RESIDENCE_COUNTRY_INVALID'], ['US', 'COUNTRY_RULE_NOT_FOUND']]) {
      const response = await commercialRequest(post('/api/public/commercial-request', {
        kind: 'contact', locale: 'fr', name: 'Ada Test', company: 'Ada SARL', email: 'ada@example.invalid', country, message: 'Mon projet',
      }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ ok: false, error });
    }
    expect(calls).toEqual([]);
  });
});

describe('Demander un rendez-vous', () => {
  it('shows the slots of the routed site and books the Appointment on that same site (BE -> EUROPE)', async () => {
    const date = tomorrow();
    const slotsResponse = await meetingSlots(createContext(new Request(`https://api.konektag.eu/api/meeting-slots?date=${date}&country=BE`)));
    expect(slotsResponse.status).toBe(200);
    const slots = await slotsResponse.json();
    // EUROPE opens 09:00-10:00, the other sites 14:00-15:00.
    expect(slots).toMatchObject({ timezone: 'Europe/Paris', konektagSite: 'konektag-fr', slots: [{ time: '09:00' }, { time: '09:30' }] });
    expect(sitesCalled()).toEqual(['europe.erp.konektag.eu']);

    calls = [];
    const response = await meetingRequest(post('/api/meeting-request', {
      country: 'BE', firstName: 'Ada', lastName: 'Test', company: 'Ada SARL', email: 'ada@example.invalid', whatsapp: '+33600000000',
      reason: 'other', details: '', platform: 'meet', date, time: slots.slots[0].time, timezone: 'Europe/Paris', locale: 'fr',
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, konektagSite: 'konektag-fr' });
    expect(sitesCalled()).toEqual(['europe.erp.konektag.eu']);
    const [lead] = table('europe.erp.konektag.eu', 'Lead');
    expect(lead).toMatchObject({ lead_owner: 'owner-fr@konektag.eu' });
    expect(table('europe.erp.konektag.eu', 'Appointment')).toEqual([expect.objectContaining({
      scheduled_time: `${date} 09:00:00`, appointment_with: 'Lead', party: lead.name,
    })]);
    expect(fetch).not.toHaveBeenCalledWith(expect.objectContaining({ hostname: 'congo.erp.konektag.eu' }), expect.anything());
  });

  it('routes CG and LB residents to their own site and timezone', async () => {
    for (const [country, host, timezone] of [['CG', 'congo.erp.konektag.eu', 'Africa/Brazzaville'], ['LB', 'liban.erp.konektag.eu', 'Asia/Beirut']]) {
      calls = [];
      const response = await meetingSlots(createContext(new Request(`https://api.konektag.eu/api/meeting-slots?date=${tomorrow()}&country=${country}`)));
      expect(await response.json()).toMatchObject({ timezone, slots: [{ time: '14:00' }, { time: '14:30' }] });
      expect(sitesCalled()).toEqual([host]);
    }
  });

  it('never reads ERPNEXT_<COUNTRY>_URL and fails explicitly when the site has no credentials', async () => {
    process.env.ERPNEXT_FR_URL = 'https://legacy.example/';
    process.env.ERPNEXT_FR_API_KEY = 'legacy';
    process.env.ERPNEXT_FR_API_SECRET = 'legacy';
    delete process.env.MARKETPLACE_FRAPPE_EUROPE_API_KEY;
    const response = await meetingSlots(createContext(new Request(`https://api.konektag.eu/api/meeting-slots?date=${tomorrow()}&country=FR`)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'KONEKTAG_SITE_NOT_CONFIGURED' });
    expect(calls).toEqual([]);
  });

  it('rejects a timezone that is not the routed entity one', async () => {
    const response = await meetingRequest(post('/api/meeting-request', {
      country: 'BE', firstName: 'Ada', lastName: 'Test', company: 'Ada SARL', email: 'ada@example.invalid', whatsapp: '+33600000000',
      reason: 'other', details: '', platform: 'meet', date: tomorrow(), time: '09:00', timezone: 'Africa/Brazzaville', locale: 'fr',
    }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('Inscription', () => {
  it('creates the Contact and its consent on the site of the residence country recorded at registration', async () => {
    database({ 'user-1': 'BE' });
    const result = await new ErpnextContactService().projectRegistration('user-1', 'BE');
    expect(result.route).toMatchObject({ slug: 'konektag-fr', site: 'EUROPE' });
    expect(sitesCalled()).toEqual(['europe.erp.konektag.eu']);
    expect(table('europe.erp.konektag.eu', 'Contact')).toEqual([expect.objectContaining({
      name: result.contactId, konektag_user_id: 'user-1', legal_country: 'BE', accepted_terms: true, terms_version: 't1',
    })]);
  });

  it('updates the Contact already on the site and falls back to the stored residence country', async () => {
    database({ 'user-2': 'CG' });
    table('congo.erp.konektag.eu', 'Contact').push({ name: 'CONTACT-9', konektag_user_id: 'user-2' });
    const result = await new ErpnextContactService().projectRegistration('user-2');
    expect(result.contactId).toBe('CONTACT-9');
    expect(calls.map(c => `${c.host} ${c.method}`)).toEqual(['congo.erp.konektag.eu GET', 'congo.erp.konektag.eu PUT']);
  });
});

describe('Achat de Points K', () => {
  const buy = (body: unknown) => recharges({
    request: new Request('https://api.konektag.eu/api/pay/recharges', { method: 'POST', body: JSON.stringify(body) }),
    locals: { user: { id: 'buyer-1' } },
  } as any);

  it('reads the payment context and fees on the buyer site before creating the checkout', async () => {
    database({ 'buyer-1': 'CG' });
    const response = await buy({ amount: 10_000, currency: 'XAF', paymentCountry: 'FR' });
    const body = await response.json();
    expect(body).toMatchObject({ id: 'order-1' });
    expect(response.status).toBe(201);
    expect(sitesCalled()).toEqual(['congo.erp.konektag.eu']);
    expect(body).toMatchObject({ konektagSite: 'konektag-cg', paymentContext: { country: 'CG', currency: 'XAF', konektagSite: 'konektag-cg' } });
    // The client paymentCountry is ignored: the order carries the routed country and site.
    const insert = m.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.api_payment_orders'))!;
    expect(insert[1][6]).toBe('CG');
    expect(JSON.parse(insert[1][7])).toEqual({ konektagSite: { slug: 'konektag-cg' } });
    // The fees displayed are the ones signed into the selection the checkout will apply.
    const [provider] = body.paymentContext.providers;
    expect(provider.fees).toEqual({ percentageBps: 150, fixedAmount: 0 });
    expect(verifyPaymentContextSelection(provider.selectionToken)).toMatchObject({ konektagSite: 'konektag-cg', fees: provider.fees });
  });

  it('shows the same fees on the checkout page as at purchase', async () => {
    database({ 'buyer-1': 'BE' });
    const purchase = await (await buy({ amount: 2_500, currency: 'EUR' })).json();
    const page = await (await paymentContextRoute({ url: new URL('https://api.konektag.eu/api/pay/payment-context?country=' + purchase.paymentContext.country) } as any)).json();
    expect(page.konektagSite).toBe(purchase.konektagSite);
    expect(page.providers.map((p: any) => p.fees)).toEqual(purchase.paymentContext.providers.map((p: any) => p.fees));
    expect(sitesCalled()).toEqual(['europe.erp.konektag.eu']);
  });

  it('refuses a currency that is not the one of the routed entity, and a buyer without rule', async () => {
    database({ 'buyer-1': 'LB' });
    const mismatch = await buy({ amount: 2_500, currency: 'EUR' });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: 'PAYMENT_CURRENCY_MISMATCH', currency: 'USD' });
    database({ 'buyer-1': 'US' });
    const noRule = await buy({ amount: 2_500, currency: 'USD' });
    expect(noRule.status).toBe(422);
    expect(await noRule.json()).toEqual({ error: 'COUNTRY_RULE_NOT_FOUND' });
  });

  it('refuses at funding a selection read on another Konektag site', async () => {
    database({ 'buyer-1': 'CG' });
    const purchase = await (await buy({ amount: 10_000, currency: 'XAF' })).json();
    database({ 'buyer-1': 'BE' });
    const europe = await (await buy({ amount: 2_500, currency: 'EUR' })).json();
    const order = { id: 'order-1', state: 'pending', funding_state: 'none', environment: 'live', order_purpose: 'wallet_recharge', business_purpose: 'wallet_recharge', order_metadata: { konektagSite: { slug: purchase.konektagSite } } };
    m.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('legal_entities')) return { rows: [{ legal_entity_id: 'le', regulatory_profile_id: 'rp', corridor_id: 'C', regulated_actor_id: 'ra', rail: 'stripe' }] };
      return { rows: [] };
    });
    const client = { query: vi.fn(async (sql: string) => String(sql).includes('FOR UPDATE') ? { rows: [order] } : { rows: [] }), release: vi.fn() };
    (m.query as any).connect = undefined;
    const pool = (await import('../../src/infrastructure/database/pool.ts')).default as any;
    pool.connect = vi.fn(async () => client);
    await expect(apiPaymentCheckoutService.prepareSelectedFunding('token', undefined, europe.paymentContext.providers[0].selectionToken))
      .rejects.toThrow('Selected Payment Context comes from another Konektag site');
  });
});
