/**
 * Generic contact and opt-in forms (KON-109).
 * Each Frappe site is a fake REST server behind the real FrappeSite client, so the
 * tests prove the doctypes, fields and site actually written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: {} }));
vi.mock('../../src/application/services/resend-service.ts', () => ({ emailService: { send: vi.fn() } }));

import { createContext } from '../../src/api/http';
import { POST as contactRoute } from '../../src/api/routes/public/forms/contact.ts';
import { POST as optinRoute } from '../../src/api/routes/public/forms/optin/index.ts';
import { POST as confirmRoute } from '../../src/api/routes/public/forms/optin/confirm.ts';
import { POST as unsubscribeRoute } from '../../src/api/routes/public/forms/optin/unsubscribe.ts';
import type { FormHttpDeps } from '../../src/application/public-forms/http.ts';
import type { FormStore } from '../../src/application/public-forms/guards.ts';
import { konektagPublicFormSites, PublicFormSiteError, type PublicFormSite, type PublicFormSites } from '../../src/application/public-forms/site.ts';
import { frappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import { signUnsubscribe } from '../../src/application/public-forms/optin.ts';

const SECRET = 'test-secret-of-public-forms-0123456789';
const hosts: Record<string, string> = {
  EUROPE: 'europe.erp.konektag.eu', KONEKTAG_CG: 'congo.erp.konektag.eu', LIBAN: 'liban.erp.konektag.eu',
  RDA: 'rocherdesages.erp.konektag.eu', ABMDEMO: 'abmdemo.erp.konektag.eu',
};
const rules: Record<string, string> = { BE: 'FR', FR: 'FR', CG: 'CG', LB: 'LB' };

type Call = { host: string; method: string; doctype: string; body?: any };
let calls: Call[];
let docs: Map<string, any[]>;
let seq: number;
let failInsert: ((host: string, doctype: string) => Response | null) | null;

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    PUBLIC_FORMS_TOKEN_SECRET: SECRET,
    MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
      'konektag-fr': { site: 'EUROPE' }, 'konektag-cg': { site: 'KONEKTAG_CG' }, 'konektag-lb': { site: 'LIBAN' },
    }),
    KONEKTAG_MEETING_FR_LEAD_OWNER: 'sales@konektag.eu',
    KONEKTAG_MEETING_FR_DEFAULT_AXIS: 'Konektag 360',
    PUBLIC_OPTIN_LISTS: JSON.stringify({
      'konektag-fr': { confirmationOrigins: ['https://www.konektag.eu'], lists: { newsletter: { emailGroup: 'Newsletter Konektag FR', consentTexts: { 'newsletter-2026-11': "J'accepte de recevoir la newsletter Konektag." } } } },
      'rocher-des-ages': { confirmationOrigins: ['https://rocherdesages.cg'], lists: { actualites: { emailGroup: 'Actualités RDA', consentTexts: { 'newsletter-2026-11': "J'accepte de recevoir les actualités du Rocher des Âges." } } } },
      'abm-demo': { confirmationOrigins: ['https://abmdemo.konektag.eu'], lists: { offres: { emailGroup: 'Offres ABM', consentTexts: { v1: "J'accepte les offres ABM." } } } },
    }),
  };
  for (const [key, host] of Object.entries(hosts)) {
    e[`MARKETPLACE_FRAPPE_${key}_URL`] = `https://${host}/`;
    e[`MARKETPLACE_FRAPPE_${key}_API_KEY`] = 'k-' + key;
    e[`MARKETPLACE_FRAPPE_${key}_API_SECRET`] = 's-' + key;
  }
  return e;
}

function table(host: string, doctype: string) {
  const key = host + '|' + doctype;
  if (!docs.has(key)) docs.set(key, []);
  return docs.get(key)!;
}

/** Minimal Frappe REST (resource list/get/insert/update, "=" filters), with the unique Email Group Member index. */
async function fakeFrappe(input: URL | string, init: RequestInit = {}) {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const [, , kind, rawDoctype, rawName] = url.pathname.split('/');
  const doctype = decodeURIComponent(rawDoctype ?? '');
  const name = rawName ? decodeURIComponent(rawName) : null;
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ host: url.hostname, method, doctype, body });
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const missing = () => new Response(JSON.stringify({ exc_type: 'DoesNotExistError' }), { status: 404 });
  if (kind !== 'resource') return missing();
  const rows = table(url.hostname, doctype);
  if (method === 'GET' && !name) {
    const filters = JSON.parse(url.searchParams.get('filters') ?? '[]') as Array<[string, string, unknown]>;
    // MariaDB's default collation compares emails case-insensitively.
    const eq = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const found = rows.filter(r => filters.every(([f, op, v]) => op !== '=' || eq(r[f], v)));
    // Frappe's default order is `modified desc`; only an explicit order_by gives the oldest first.
    if (url.searchParams.get('order_by') === 'creation asc') found.sort((a, b) => String(a.creation).localeCompare(String(b.creation)));
    else found.reverse();
    return ok(found.slice(0, Number(url.searchParams.get('limit_page_length') ?? 500)));
  }
  if (method === 'GET') {
    const row = rows.find(r => r.name === name);
    return row ? ok(row) : missing();
  }
  if (method === 'POST') {
    const forced = failInsert?.(url.hostname, doctype);
    if (forced) return forced;
    if (doctype === 'Email Group Member' && rows.some(r => r.email_group === body.email_group && r.email === body.email))
      return new Response(JSON.stringify({ exc_type: 'DuplicateEntryError' }), { status: 409 });
    if (doctype === 'Email Group Member' && !table(url.hostname, 'Email Group').some(g => g.name === body.email_group))
      return new Response(JSON.stringify({ exc_type: 'LinkValidationError' }), { status: 417 });
    const prefix = doctype === 'Lead' ? 'CRM-LEAD-2026-' : doctype === 'Issue' ? 'ISS-2026-' : doctype.slice(0, 3).toUpperCase() + '-';
    const row = { ...body, name: prefix + String(++seq).padStart(5, '0'), creation: '2026-11-21 09:00:' + String(seq).padStart(2, '0') };
    rows.push(row);
    return ok(row);
  }
  if (method === 'PUT') {
    const row = rows.find(r => r.name === name);
    if (!row) return missing();
    Object.assign(row, body);
    return ok(row);
  }
  return missing();
}

function memoryStore(): FormStore & { values: Map<string, string>; counters: Map<string, number> } {
  const values = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    values, counters,
    async checkRateLimit(key, max) { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n <= max; },
    async setIfAbsent(key, value) { if (values.has(key)) return false; values.set(key, value); return true; },
    async deleteIfEquals(key, value) { if (values.get(key) === value) values.delete(key); },
    async getValue(key) { return values.get(key) || null; },
    async setValue(key, value) { values.set(key, value); },
  };
}

const database = {
  query: async (_sql: string, values?: unknown[]) => {
    const country = rules[String(values?.[0])];
    return { rows: country ? [{ payment_country: country }] : [] };
  },
};

/**
 * Stand-in for the site registry of KON-107: two customer tenants addressed by siteId.
 * The Konektag entities keep the published country routing.
 */
function sitesWithCustomers(e: NodeJS.ProcessEnv): PublicFormSites {
  const konektag = konektagPublicFormSites(e, fakeFrappe as typeof fetch, database);
  const customers: Record<string, { tenantId: string; siteId: string; origins: string[] }> = {
    RDA: { tenantId: 'rocher-des-ages', siteId: 'RDA', origins: ['https://rocherdesages.cg'] },
    ABMDEMO: { tenantId: 'abm-demo', siteId: 'ABMDEMO', origins: ['https://abmdemo.konektag.eu'] },
  };
  const customer = (c: { tenantId: string; siteId: string }): PublicFormSite =>
    ({ tenantId: c.tenantId, siteId: c.siteId, kind: 'CUSTOMER', frappe: frappeSite(c.siteId, e, fakeFrappe as typeof fetch), leadDefaults: {} });
  return {
    async resolve(selector, context) {
      if (!selector.siteId || selector.country) return konektag.resolve(selector, context);
      const c = customers[selector.siteId];
      if (!c) throw new PublicFormSiteError('SITE_NOT_FOUND', 404);
      if (!context.origin || !c.origins.includes(context.origin)) throw new PublicFormSiteError('ORIGIN_NOT_ALLOWED', 403);
      return customer(c);
    },
    async resolveRecorded(tenantId, siteId) {
      const c = Object.values(customers).find(x => x.tenantId === tenantId && x.siteId === siteId);
      return c ? customer(c) : konektag.resolveRecorded(tenantId, siteId);
    },
  };
}

let store: ReturnType<typeof memoryStore>;
let mails: Array<{ to: string; subject: string; html: string; idempotencyKey?: string }>;
let deps: FormHttpDeps;

beforeEach(() => {
  calls = []; docs = new Map(); seq = 0; failInsert = null; mails = [];
  store = memoryStore();
  const e = env();
  deps = {
    sites: sitesWithCustomers(e), store, env: e, fetchImpl: fakeFrappe as typeof fetch,
    sendEmail: async mail => { mails.push(mail); return true; },
    now: () => new Date('2026-11-21T09:00:00.000Z'),
  };
  table('europe.erp.konektag.eu', 'Email Group').push({ name: 'Newsletter Konektag FR' });
  table('rocherdesages.erp.konektag.eu', 'Email Group').push({ name: 'Actualités RDA' });
  table('abmdemo.erp.konektag.eu', 'Email Group').push({ name: 'Offres ABM' });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function ctx(path: string, body: unknown, headers: Record<string, string> = {}, peer = '203.0.113.7') {
  return createContext(new Request('https://api.konektag.eu' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), {}, peer);
}

const contact = (over: Record<string, unknown> = {}) => ({
  country: 'BE', intent: 'sales', name: 'Awa Diallo', email: 'Awa@Example.com', company: 'Diallo SARL',
  subject: 'Devis', message: 'Bonjour, je souhaite un devis.', sourceUrl: 'https://www.konektag.eu/contact', ...over,
});
const optin = (over: Record<string, unknown> = {}) => ({
  country: 'FR', list: 'newsletter', email: 'awa@example.com', locale: 'fr',
  consent: { accepted: true, textVersion: 'newsletter-2026-11' },
  confirmationUrl: 'https://www.konektag.eu/newsletter/confirmation', sourceUrl: 'https://www.konektag.eu/', ...over,
});
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const writes = (doctype?: string) => calls.filter(c => c.method !== 'GET' && (!doctype || c.doctype === doctype));
const tokenOf = (mail: { html: string }) => /#token=([A-Za-z0-9_-]{43})/.exec(mail.html)![1];

describe('POST /api/public/forms/contact', () => {
  it('routes BE to konektag-fr, creates the Lead with the entity rules and a received Communication', async () => {
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, reference: expect.stringMatching(/^WEB-[2-9A-HJ-NP-Z]{10}$/), replayed: false });
    expect(new Set(calls.map(c => c.host))).toEqual(new Set(['europe.erp.konektag.eu']));
    const lead = writes('Lead')[0].body;
    expect(lead).toMatchObject({ lead_name: 'Awa Diallo', email_id: 'awa@example.com', company_name: 'Diallo SARL', lead_owner: 'sales@konektag.eu', custom_axis: 'Konektag 360' });
    const comm = writes('Communication')[0].body;
    expect(comm).toMatchObject({ communication_type: 'Communication', sent_or_received: 'Received', sender: 'awa@example.com', reference_doctype: 'Lead', reference_name: 'CRM-LEAD-2026-00001' });
    expect(comm.subject).toBe(`[${r.body.reference}] Devis`);
    expect(comm.content).toContain('https://www.konektag.eu/contact');
    // The reference is opaque: no CRM name in the answer, and no subscription or e-mail.
    expect(JSON.stringify(r.body)).not.toContain('CRM-LEAD');
    expect(writes('Email Group Member')).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it('attaches a second request to the oldest Lead of the same email (case-insensitive)', async () => {
    table('europe.erp.konektag.eu', 'Lead').push(
      { name: 'CRM-LEAD-2026-00007', email_id: 'AWA@example.com', creation: '2026-01-02 10:00:00' },
      { name: 'CRM-LEAD-2026-00042', email_id: 'awa@example.com', creation: '2026-03-02 10:00:00' },
    );
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact({ intent: 'general' })), deps));
    expect(r.status).toBe(201);
    expect(writes('Lead')).toHaveLength(0);
    expect(writes('Communication')[0].body.reference_name).toBe('CRM-LEAD-2026-00007');
  });

  it('opens an Issue for a support request and does not create a Lead', async () => {
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact({ intent: 'support', subject: '' })), deps));
    expect(r.status).toBe(201);
    expect(writes().map(c => c.doctype)).toEqual(['Issue']);
    expect(writes('Issue')[0].body).toMatchObject({ raised_by: 'awa@example.com', subject: `[${r.body.reference}] Demande de support` });
  });

  it('sets UTM links only when the site already has them', async () => {
    table('europe.erp.konektag.eu', 'UTM Campaign').push({ name: 'black-friday' });
    await contactRoute(ctx('/api/public/forms/contact', contact({ campaign: { source: 'facebook', name: 'black-friday' } })), deps);
    const lead = writes('Lead')[0].body;
    expect(lead.utm_campaign).toBe('black-friday');
    expect(lead).not.toHaveProperty('utm_source');
    expect(writes('Communication')[0].body.content).toContain('facebook / black-friday');
  });

  it('replays the same submission without writing twice', async () => {
    const first = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps));
    const second = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps));
    expect(second).toEqual({ status: 200, body: { ok: true, reference: first.body.reference, replayed: true } });
    expect(writes('Communication')).toHaveLength(1);
  });

  it('rejects an Idempotency-Key reused with another message', async () => {
    await contactRoute(ctx('/api/public/forms/contact', contact(), { 'idempotency-key': 'key-12345678' }), deps);
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact({ message: 'Autre message' }), { 'idempotency-key': 'key-12345678' }), deps));
    expect(r).toEqual({ status: 409, body: { ok: false, error: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('retries a failed Communication on the Lead created by the first attempt', async () => {
    failInsert = (_h, d) => d === 'Communication' ? new Response('{}', { status: 503 }) : null;
    const failed = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps));
    expect(failed).toEqual({ status: 503, body: { ok: false, error: 'CRM_UNAVAILABLE' } });
    failInsert = null;
    const retried = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps));
    expect(retried.status).toBe(201);
    expect(writes('Lead')).toHaveLength(1);
    expect(table('europe.erp.konektag.eu', 'Communication')).toHaveLength(1);
  });

  it('reports a rejected Lead (missing mandatory field or permission) as CRM_REJECTED', async () => {
    failInsert = (_h, d) => d === 'Lead' ? new Response(JSON.stringify({ exc_type: 'MandatoryError' }), { status: 417 }) : null;
    expect(await json(await contactRoute(ctx('/api/public/forms/contact', contact()), deps))).toEqual({ status: 503, body: { ok: false, error: 'CRM_REJECTED' } });
  });

  it('writes a customer site request only to that customer site', async () => {
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact({ country: undefined, siteId: 'RDA' }), { origin: 'https://rocherdesages.cg' }), deps));
    expect(r.status).toBe(201);
    expect(new Set(calls.map(c => c.host))).toEqual(new Set(['rocherdesages.erp.konektag.eu']));
    expect(writes('Lead')[0].body).not.toHaveProperty('lead_owner');
  });

  it('refuses a customer site from another origin and an unknown site', async () => {
    expect(await json(await contactRoute(ctx('/api/public/forms/contact', contact({ country: undefined, siteId: 'RDA' }), { origin: 'https://abmdemo.konektag.eu' }), deps)))
      .toEqual({ status: 403, body: { ok: false, error: 'ORIGIN_NOT_ALLOWED' } });
    expect(await json(await contactRoute(ctx('/api/public/forms/contact', contact({ country: undefined, siteId: 'OTHER' }), { origin: 'https://rocherdesages.cg' }), deps)))
      .toEqual({ status: 404, body: { ok: false, error: 'SITE_NOT_FOUND' } });
    expect(calls).toHaveLength(0);
  });

  it('validates the selector, the fields, the honeypot and the content type', async () => {
    const cases: Array<[unknown, number, string, Record<string, string>?]> = [
      [contact({ siteId: 'RDA' }), 400, 'SITE_SELECTOR_CONFLICT'],
      [contact({ country: undefined }), 400, 'SITE_SELECTOR_REQUIRED'],
      [contact({ country: 'Atlantide' }), 422, 'RESIDENCE_COUNTRY_INVALID'],
      [contact({ country: 'JP' }), 422, 'COUNTRY_RULE_NOT_FOUND'],
      [contact({ email: 'not-an-email' }), 400, 'BAD_FIELDS'],
      [contact({ unknown: 1 }), 400, 'BAD_FIELDS'],
      [contact({ website: 'http://spam' }), 400, 'SPAM_REJECTED'],
      ['{', 400, 'BAD_JSON'],
    ];
    for (const [body, status, error] of cases)
      expect(await json(await contactRoute(ctx('/api/public/forms/contact', body), deps))).toEqual({ status, body: { ok: false, error } });
    const form = createContext(new Request('https://api.konektag.eu/api/public/forms/contact', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' }));
    expect(await json(await contactRoute(form, deps))).toEqual({ status: 415, body: { ok: false, error: 'BAD_CONTENT_TYPE' } });
    expect(calls).toHaveLength(0);
  });

  it('without the default binding of a site registry, a siteId is refused explicitly', async () => {
    const e = env();
    const only = { ...deps, sites: konektagPublicFormSites(e, fakeFrappe as typeof fetch, database) };
    expect(await json(await contactRoute(ctx('/api/public/forms/contact', contact({ country: undefined, siteId: 'RDA' })), only)))
      .toEqual({ status: 503, body: { ok: false, error: 'SITE_ROUTING_UNAVAILABLE' } });
  });

  it('rate limits per email and per peer', async () => {
    for (let i = 0; i < 5; i++) await contactRoute(ctx('/api/public/forms/contact', contact({ message: 'Message numéro ' + i })), deps);
    const r = await contactRoute(ctx('/api/public/forms/contact', contact({ message: 'Message numéro 6' })), deps);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
    for (let i = 0; i < 120; i++) await contactRoute(ctx('/api/public/forms/contact', contact({ email: `p${i}@example.com` }), {}, '198.51.100.1'), deps);
    expect((await contactRoute(ctx('/api/public/forms/contact', contact({ email: 'last@example.com' }), {}, '198.51.100.1'), deps)).status).toBe(429);
    // No personal data in Redis keys.
    expect([...store.counters.keys()].join(' ')).not.toMatch(/example\.com|198\.51/);
  });

  it('is unavailable without the server secret', async () => {
    const r = await json(await contactRoute(ctx('/api/public/forms/contact', contact()), { ...deps, env: { ...deps.env, PUBLIC_FORMS_TOKEN_SECRET: '' } }));
    expect(r).toEqual({ status: 503, body: { ok: false, error: 'SERVICE_UNAVAILABLE' } });
  });
});

describe('opt-in: request, confirm, unsubscribe', () => {
  it('sends a confirmation e-mail and writes nothing to Frappe before confirmation', async () => {
    const r = await json(await optinRoute(ctx('/api/public/forms/optin', optin(), { origin: 'https://www.konektag.eu' }), deps));
    expect(r).toEqual({ status: 202, body: { ok: true, status: 'CONFIRMATION_SENT' } });
    expect(writes()).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('awa@example.com');
    // Token in the fragment: never sent to the confirmation page server nor in a Referer.
    expect(mails[0].html).toContain('https://www.konektag.eu/newsletter/confirmation#token=');
    expect(mails[0].html).toContain('newsletter-2026-11');
    expect(mails[0].html).toContain('recevoir la newsletter Konektag');
    // Redis keeps the pending consent under a hash of the token only.
    expect([...store.values.keys()].some(k => k.includes(tokenOf(mails[0])))).toBe(false);
  });

  it('confirms: inactive member, proof Comment, then activation; second click is idempotent', async () => {
    await optinRoute(ctx('/api/public/forms/optin', optin({ campaign: 'automne' }), { origin: 'https://www.konektag.eu' }), deps);
    const token = tokenOf(mails[0]);
    const r = await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token }, {}, '203.0.113.9'), deps));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'SUBSCRIBED', list: 'newsletter', unsubscribeToken: expect.stringContaining('.') });
    expect(writes().map(c => `${c.method} ${c.doctype}`)).toEqual(['POST Email Group Member', 'POST Comment', 'PUT Email Group Member']);
    expect(writes('Email Group Member')[0].body).toEqual({ doctype: 'Email Group Member', email_group: 'Newsletter Konektag FR', email: 'awa@example.com', unsubscribed: 1 });
    const comment = writes('Comment')[0].body;
    expect(comment).toMatchObject({ comment_type: 'Info', reference_doctype: 'Email Group Member', reference_name: 'EMA-00001' });
    for (const text of ['konektag-consent-proof/1', 'double-opt-in', 'newsletter-2026-11', 'recevoir la newsletter Konektag', '2026-11-21T09:00:00.000Z', 'https://www.konektag.eu', 'automne', 'konektag-fr', 'EUROPE', '&quot;signature&quot;: &quot;'])
      expect(comment.content).toContain(text);
    expect(comment.content).not.toContain('203.0.113');
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(0);

    // A repeated click succeeds but does not hand out the unsubscribe capability again.
    const again = await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token }), deps));
    expect(again).toEqual({ status: 200, body: { ok: true, status: 'SUBSCRIBED', list: 'newsletter', unsubscribeToken: null } });
    expect(writes()).toHaveLength(3);
    expect([...store.values.values()].join(' ')).not.toContain('awa@example.com');
  });

  it('never leaves an active member without proof', async () => {
    await optinRoute(ctx('/api/public/forms/optin', optin(), { origin: 'https://www.konektag.eu' }), deps);
    failInsert = (_h, d) => d === 'Comment' ? new Response('{}', { status: 403 }) : null;
    const r = await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: tokenOf(mails[0]) }), deps));
    expect(r).toEqual({ status: 503, body: { ok: false, error: 'OPTIN_UNAVAILABLE' } });
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(1);
    failInsert = null;
    expect((await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: tokenOf(mails[0]) }), deps)).status).toBe(200);
    expect(table('europe.erp.konektag.eu', 'Email Group Member')).toHaveLength(1);
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(0);
  });

  it('answers an already subscribed address like any other, without sending a new e-mail', async () => {
    table('europe.erp.konektag.eu', 'Email Group Member').push({ name: 'M1', email_group: 'Newsletter Konektag FR', email: 'awa@example.com', unsubscribed: 0 });
    const r = await json(await optinRoute(ctx('/api/public/forms/optin', optin(), { origin: 'https://www.konektag.eu' }), deps));
    expect(r).toEqual({ status: 202, body: { ok: true, status: 'CONFIRMATION_SENT' } });
    expect(mails).toHaveLength(0);
  });

  it('re-subscribes a former member only after a new confirmation, with a new proof', async () => {
    table('europe.erp.konektag.eu', 'Email Group Member').push({ name: 'M1', email_group: 'Newsletter Konektag FR', email: 'awa@example.com', unsubscribed: 1 });
    await optinRoute(ctx('/api/public/forms/optin', optin(), { origin: 'https://www.konektag.eu' }), deps);
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(1);
    await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: tokenOf(mails[0]) }), deps);
    expect(writes().map(c => `${c.method} ${c.doctype}`)).toEqual(['POST Comment', 'PUT Email Group Member']);
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(0);
  });

  it('unsubscribes with the signed token, idempotently, and records the withdrawal', async () => {
    await optinRoute(ctx('/api/public/forms/optin', optin(), { origin: 'https://www.konektag.eu' }), deps);
    const confirmed = await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: tokenOf(mails[0]) }), deps));
    const token = confirmed.body.unsubscribeToken;
    expect(token).not.toContain('example');
    expect(Buffer.from(token.split('.')[0], 'base64url').toString()).not.toContain('awa');
    for (let i = 0; i < 2; i++)
      expect(await json(await unsubscribeRoute(ctx('/api/public/forms/optin/unsubscribe', { token }), deps))).toEqual({ status: 200, body: { ok: true, status: 'UNSUBSCRIBED' } });
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(1);
    expect(writes('Comment').map(c => c.body.content.includes('&quot;unsubscribe&quot;'))).toEqual([false, true]);
  });

  it('rejects forged, tampered or cross-tenant unsubscribe tokens', async () => {
    table('europe.erp.konektag.eu', 'Email Group Member').push({ name: 'M1', email_group: 'Newsletter Konektag FR', email: 'a@example.com', unsubscribed: 0 });
    table('rocherdesages.erp.konektag.eu', 'Email Group Member').push({ name: 'M1', email_group: 'Actualités RDA', email: 'b@example.com', unsubscribed: 0 });
    const forged = signUnsubscribe({ tenantId: 'konektag-fr', siteId: 'EUROPE', member: 'M1', emailGroup: 'Newsletter Konektag FR' }, 'another-secret-another-secret-0000');
    // A tenant cannot point its token at another tenant's site.
    const crossSite = signUnsubscribe({ tenantId: 'konektag-fr', siteId: 'RDA', member: 'M1', emailGroup: 'Actualités RDA' }, SECRET);
    // A token of another list does not reach this member.
    const otherGroup = signUnsubscribe({ tenantId: 'konektag-fr', siteId: 'EUROPE', member: 'M1', emailGroup: 'Liste interne' }, SECRET);
    const valid = signUnsubscribe({ tenantId: 'konektag-fr', siteId: 'EUROPE', member: 'M1', emailGroup: 'Newsletter Konektag FR' }, SECRET);
    const [payload, sig] = valid.split('.');
    const tampered = Buffer.from(JSON.stringify({ v: 1, t: 'rocher-des-ages', s: 'RDA', m: 'M1', g: 'Actualités RDA' })).toString('base64url') + '.' + sig;
    expect(payload).toBeTruthy();
    expect(await json(await unsubscribeRoute(ctx('/api/public/forms/optin/unsubscribe', { token: forged }), deps))).toEqual({ status: 400, body: { ok: false, error: 'UNSUBSCRIBE_TOKEN_INVALID' } });
    expect(await json(await unsubscribeRoute(ctx('/api/public/forms/optin/unsubscribe', { token: tampered }), deps))).toEqual({ status: 400, body: { ok: false, error: 'UNSUBSCRIBE_TOKEN_INVALID' } });
    expect(await json(await unsubscribeRoute(ctx('/api/public/forms/optin/unsubscribe', { token: crossSite }), deps))).toEqual({ status: 404, body: { ok: false, error: 'SITE_NOT_FOUND' } });
    expect(await json(await unsubscribeRoute(ctx('/api/public/forms/optin/unsubscribe', { token: otherGroup }), deps))).toEqual({ status: 400, body: { ok: false, error: 'UNSUBSCRIBE_TOKEN_INVALID' } });
    expect(table('europe.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(0);
    expect(table('rocherdesages.erp.konektag.eu', 'Email Group Member')[0].unsubscribed).toBe(0);
  });

  it('keeps customer tenants isolated: own lists, own confirmation origins, own site', async () => {
    const rda = (over: Record<string, unknown>) => optin({ country: undefined, siteId: 'RDA', list: 'actualites', confirmationUrl: 'https://rocherdesages.cg/inscription', ...over });
    const headers = { origin: 'https://rocherdesages.cg' };
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', rda({ list: 'offres' }), headers), deps))).toEqual({ status: 404, body: { ok: false, error: 'OPTIN_LIST_NOT_FOUND' } });
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', rda({ list: 'newsletter' }), headers), deps))).toEqual({ status: 404, body: { ok: false, error: 'OPTIN_LIST_NOT_FOUND' } });
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', rda({ confirmationUrl: 'https://evil.example/confirm' }), headers), deps))).toEqual({ status: 403, body: { ok: false, error: 'CONFIRMATION_URL_NOT_ALLOWED' } });
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', rda({ confirmationUrl: 'https://abmdemo.konektag.eu/x' }), headers), deps))).toEqual({ status: 403, body: { ok: false, error: 'CONFIRMATION_URL_NOT_ALLOWED' } });
    expect(mails).toHaveLength(0);
    expect((await optinRoute(ctx('/api/public/forms/optin', rda({}), headers), deps)).status).toBe(202);
    await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: tokenOf(mails[0]) }), deps);
    expect(new Set(calls.map(c => c.host))).toEqual(new Set(['rocherdesages.erp.konektag.eu']));
    expect(table('rocherdesages.erp.konektag.eu', 'Email Group Member')[0]).toMatchObject({ email_group: 'Actualités RDA', unsubscribed: 0 });
  });

  it('requires explicit consent to a server-held text and refuses an absent Email Group before any e-mail', async () => {
    for (const consent of [undefined, { accepted: false, textVersion: 'newsletter-2026-11' }, { accepted: true, textVersion: 'newsletter-2026-11', text: 'Texte arbitraire du navigateur' }])
      expect((await json(await optinRoute(ctx('/api/public/forms/optin', optin({ consent })), deps))).body.error).toBe('BAD_FIELDS');
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', optin({ consent: { accepted: true, textVersion: 'v-inventee' } })), deps)))
      .toEqual({ status: 422, body: { ok: false, error: 'CONSENT_VERSION_UNKNOWN' } });
    docs.delete('europe.erp.konektag.eu|Email Group');
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', optin()), deps))).toEqual({ status: 503, body: { ok: false, error: 'OPTIN_LIST_UNAVAILABLE' } });
    expect(mails).toHaveLength(0);
  });

  it('reports an unknown or expired confirmation token', async () => {
    expect(await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: 'A'.repeat(43) }), deps))).toEqual({ status: 404, body: { ok: false, error: 'CONFIRMATION_NOT_FOUND' } });
    expect(await json(await confirmRoute(ctx('/api/public/forms/optin/confirm', { token: 'short' }), deps))).toEqual({ status: 400, body: { ok: false, error: 'BAD_FIELDS' } });
  });

  it('limits confirmation e-mails per address to protect third parties', async () => {
    for (let i = 0; i < 3; i++) expect((await optinRoute(ctx('/api/public/forms/optin', optin()), deps)).status).toBe(202);
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', optin()), deps))).toEqual({ status: 429, body: { ok: false, error: 'RATE_LIMITED' } });
    expect(mails).toHaveLength(3);
  });

  it('drops the pending consent when the confirmation e-mail cannot be sent', async () => {
    const r = await json(await optinRoute(ctx('/api/public/forms/optin', optin()), { ...deps, sendEmail: async () => false }));
    expect(r).toEqual({ status: 503, body: { ok: false, error: 'CONFIRMATION_EMAIL_UNAVAILABLE' } });
    expect([...store.values.entries()].filter(([k, v]) => k.includes(':pending:') && v)).toHaveLength(0);
  });

  it('requires a Turnstile token for opt-in when the server has a Turnstile secret', async () => {
    const strict = { ...deps, env: { ...deps.env, TURNSTILE_SECRET_KEY: 'turnstile-secret' } };
    expect(await json(await optinRoute(ctx('/api/public/forms/optin', optin()), strict))).toEqual({ status: 403, body: { ok: false, error: 'INVALID_VERIFICATION' } });
    expect(mails).toHaveLength(0);
  });
});

describe('contact: Frappe field constraints and concurrency', () => {
  it('refuses phone and lengths that the Frappe fields would reject', async () => {
    for (const over of [{ phone: '+33 1 23 45 67 89 poste 12' }, { phone: 'call me' }, { name: 'n'.repeat(141) }, { company: 'c'.repeat(141) }])
      expect(await json(await contactRoute(ctx('/api/public/forms/contact', contact(over)), deps))).toEqual({ status: 400, body: { ok: false, error: 'BAD_FIELDS' } });
    expect((await contactRoute(ctx('/api/public/forms/contact', contact({ phone: '+242 06 123 45 67' })), deps)).status).toBe(201);
  });

  it('reuses the Lead created by a concurrent request of the same address', async () => {
    failInsert = (host, doctype) => {
      if (doctype !== 'Lead') return null;
      table(host, 'Lead').push({ name: 'CRM-LEAD-2026-00099', email_id: 'awa@example.com', creation: '2026-11-21 08:59:59' });
      return new Response(JSON.stringify({ exc_type: 'DuplicateEntryError' }), { status: 409 });
    };
    expect((await contactRoute(ctx('/api/public/forms/contact', contact()), deps)).status).toBe(201);
    expect(writes('Communication')[0].body.reference_name).toBe('CRM-LEAD-2026-00099');
  });
});
