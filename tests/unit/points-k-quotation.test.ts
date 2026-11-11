/**
 * Points K flow 1: Customer (alias = Keycloak subject), Lead (customer) and a
 * draft Quotation (quotation_to Lead) on the site of the selected country.
 *
 * The fake ERPNext below plays the server side of the verified v16 contract:
 * it applies the site's tax template and computes net_total, taxes, grand_total
 * and rounded_total on every save. The API never sees those rates; each test
 * compares the API result with a brute-force scan of the fake's own totals.
 * Tax rates here are test fixtures, not the sites' configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), lockQuery: vi.fn(), release: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query, connect: m.connect } }));

import { createContext } from '../../src/api/http';
import { POST as quotations } from '../../src/api/routes/points-k/quotations.ts';

const rules: Record<string, string> = { BE: 'FR', FR: 'FR', CG: 'CG', CM: 'CG', LB: 'LB' };
const hosts: Record<string, string> = { EUROPE: 'europe.erp.konektag.eu', KONEKTAG_CG: 'congo.erp.konektag.eu', LIBAN: 'liban.erp.konektag.eu' };

type Tax = { charge_type: 'On Net Total' | 'Actual'; rate?: number; amount?: number; description: string };
type SiteConfig = {
  currency: string; precision: number; fraction: number; disableRounded: 0 | 1;
  item: string; priceList: string; rate: number; taxes: Tax[];
};
let sites: Record<string, SiteConfig>;
let docs: Map<string, any[]>;
let calls: Array<{ host: string; method: string; doctype: string }>;
let seq: number;
let rejectQuotation: { status: number; body: unknown } | null;
const saved = { ...process.env };

const KEYCLOAK = 'kc-9f1c2b7e-0000-4000-8000-000000000001';

function defaultSites(): Record<string, SiteConfig> {
  return {
    'europe.erp.konektag.eu': { currency: 'EUR', precision: 2, fraction: 0.01, disableRounded: 0, item: 'POINTS-K', priceList: 'Standard Selling', rate: 1, taxes: [{ charge_type: 'On Net Total', rate: 20, description: 'TVA' }] },
    'congo.erp.konektag.eu': { currency: 'XAF', precision: 0, fraction: 0, disableRounded: 0, item: 'POINTS-K', priceList: 'Vente XAF', rate: 655, taxes: [{ charge_type: 'On Net Total', rate: 18.9, description: 'TVA' }] },
    'liban.erp.konektag.eu': { currency: 'USD', precision: 2, fraction: 0.01, disableRounded: 0, item: 'POINTS-K', priceList: 'Selling USD', rate: 1, taxes: [{ charge_type: 'On Net Total', rate: 11, description: 'VAT' }] },
  };
}

const round = (value: number, precision: number) => Number((Math.round(Number(value + 'e' + precision)) + 'e-' + precision));
/** ERPNext round_based_on_smallest_currency_fraction: whole units when the Currency has no fraction. */
const roundFraction = (value: number, fraction: number, precision: number) =>
  fraction ? round(Math.round(value / fraction) * fraction, precision) : Math.round(value);

/** Totals of the fake ERPNext for one quantity: the oracle used by the assertions. */
function erpTotals(cfg: SiteConfig, qty: number) {
  const net = round(qty * cfg.rate, cfg.precision);
  let running = net;
  const taxes = cfg.taxes.map(tax => {
    const amount = tax.charge_type === 'Actual' ? tax.amount! : round(net * tax.rate! / 100, cfg.precision);
    running = round(running + amount, cfg.precision);
    return { charge_type: tax.charge_type, account_head: 'Tax - K', description: tax.description, rate: tax.rate ?? 0, tax_amount: amount, total: running };
  });
  const grand = running;
  const rounded = cfg.disableRounded ? 0 : roundFraction(grand, cfg.fraction, cfg.precision);
  return { net, taxes, grand, rounded, total: cfg.disableRounded ? grand : rounded };
}

function bruteForceMax(cfg: SiteConfig, budget: number) {
  let qty = 0;
  while (erpTotals(cfg, qty + 1).total <= budget) qty++;
  return qty;
}

function table(host: string, doctype: string) {
  const key = host + '|' + doctype;
  if (!docs.has(key)) docs.set(key, []);
  return docs.get(key)!;
}

function computeQuotation(host: string, doc: any) {
  const cfg = sites[host];
  const items = doc.items.map((row: any) => {
    const price = table(host, 'Item Price').find(p => p.item_code === row.item_code && p.price_list === doc.selling_price_list);
    return { ...row, price_list_rate: price?.price_list_rate ?? 0, rate: price?.price_list_rate ?? 0, amount: round(row.qty * (price?.price_list_rate ?? 0), cfg.precision) };
  });
  const totals = erpTotals(cfg, items[0].qty);
  Object.assign(doc, {
    items, docstatus: 0, status: 'Draft', company: 'Konektag ' + cfg.currency, disable_rounded_total: cfg.disableRounded,
    taxes_and_charges: 'Sales Taxes - K', taxes: totals.taxes, net_total: totals.net,
    total_taxes_and_charges: round(totals.grand - totals.net, cfg.precision), grand_total: totals.grand,
    rounded_total: totals.rounded, rounding_adjustment: cfg.disableRounded ? 0 : round(totals.rounded - totals.grand, cfg.precision),
  });
  return doc;
}

/**
 * ERPNext 16.54.0 Customer.update_lead_status (after_insert, or on_update when
 * lead_name changes): the Lead becomes Converted and its Quotations to the Lead
 * are moved to the Customer.
 */
function customerLeadHook(host: string, customer: any) {
  if (!customer.lead_name) return;
  const lead = table(host, 'Lead').find(l => l.name === customer.lead_name);
  if (lead) lead.status = 'Converted';
  for (const q of table(host, 'Quotation'))
    if (q.quotation_to === 'Lead' && q.party_name === customer.lead_name) Object.assign(q, { quotation_to: 'Customer', party_name: customer.name });
}

/**
 * ERPNext 16.54.0 quotation._make_customer, run by make_sales_order:
 * get_existing_customer_name -> frappe.db.get_value("Customer", {"lead_name": party_name});
 * when none, create_customer_from_lead inserts a new Customer (no alias).
 */
function makeSalesOrderCustomer(host: string, quotationName: string) {
  const quotation = table(host, 'Quotation').find(q => q.name === quotationName);
  if (quotation.quotation_to === 'Customer') return table(host, 'Customer').find(c => c.name === quotation.party_name);
  const existing = table(host, 'Customer').find(c => c.lead_name === quotation.party_name);
  if (existing) return existing;
  const lead = table(host, 'Lead').find(l => l.name === quotation.party_name);
  const created = { name: 'CUSTOMER-FROM-' + lead.name, customer_name: lead.lead_name, lead_name: lead.name, disabled: 0 };
  table(host, 'Customer').push(created);
  customerLeadHook(host, created);
  return created;
}

/** Minimal Frappe REST (resource list/get/insert/update with "=" filters) with ERPNext-side Quotation totals. */
async function fakeFrappe(input: URL | string, init: RequestInit = {}) {
  const url = new URL(String(input));
  const method = init.method ?? 'GET';
  const [, , kind, rawDoctype, rawName] = url.pathname.split('/');
  const doctype = decodeURIComponent(rawDoctype ?? '');
  const name = rawName ? decodeURIComponent(rawName) : null;
  calls.push({ host: url.hostname, method, doctype });
  const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 });
  const fail = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
  if (kind !== 'resource') return fail(404);
  const rows = table(url.hostname, doctype);
  if (method === 'GET' && !name) {
    const filters = JSON.parse(url.searchParams.get('filters') ?? '[]') as Array<[string, string, unknown]>;
    const fields = JSON.parse(url.searchParams.get('fields') ?? '["name"]') as string[];
    return ok(rows.filter(r => filters.every(([f, op, v]) => op === '=' && r[f] === v))
      .map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? null]))));
  }
  if (method === 'GET' && name) {
    const doc = rows.find(r => r.name === name);
    return doc ? ok(structuredClone(doc)) : fail(404, { exc_type: 'DoesNotExistError' });
  }
  if (doctype === 'Quotation' && rejectQuotation) return fail(rejectQuotation.status, rejectQuotation.body);
  if (method === 'POST') {
    const body = JSON.parse(String(init.body));
    if (doctype === 'Customer' && body.alias && rows.some(r => r.alias === body.alias))
      return fail(409, { exc_type: 'UniqueValidationError', exception: 'Duplicate alias' });
    const doc = { ...body, name: doctype.toUpperCase().replace(/ /g, '-') + '-' + (++seq), creation: `2026-11-11 10:00:${String(seq).padStart(2, '0')}`, disabled: 0 };
    if (doctype === 'Lead') Object.assign(doc, { status: 'Lead', lead_name: body.first_name });
    if (doctype === 'Customer' && body.lead_name && rows.some(r => r.lead_name === body.lead_name))
      return fail(409, { exc_type: 'DuplicateEntryError', exception: 'Lead already converted' });
    if (doctype === 'Quotation') computeQuotation(url.hostname, doc);
    rows.push(doc);
    if (doctype === 'Customer') customerLeadHook(url.hostname, doc);
    return ok(structuredClone(doc));
  }
  if (method === 'PUT' && name) {
    const doc = rows.find(r => r.name === name);
    if (!doc) return fail(404);
    const oldLead = doc.lead_name;
    Object.assign(doc, JSON.parse(String(init.body)));
    if (doctype === 'Quotation') computeQuotation(url.hostname, doc);
    if (doctype === 'Customer' && doc.lead_name !== oldLead) customerLeadHook(url.hostname, doc);
    return ok(structuredClone(doc));
  }
  return fail(405);
}

function seedCatalog() {
  for (const [host, cfg] of Object.entries(sites)) {
    table(host, 'Item').push({ name: cfg.item, item_code: cfg.item, stock_uom: 'Nos', disabled: 0, is_sales_item: 1, has_variants: 0 });
    table(host, 'Price List').push({ name: cfg.priceList, currency: cfg.currency, enabled: 1, selling: 1 });
    table(host, 'Item Price').push({ name: 'IP-' + cfg.currency, item_code: cfg.item, price_list: cfg.priceList, price_list_rate: cfg.rate, currency: cfg.currency, selling: 1, uom: 'Nos', customer: null, valid_from: '2026-01-01', valid_upto: null });
  }
}

const user = { id: 'user-1', keycloak_id: KEYCLOAK, username: 'ada', legal_country: 'LB' };
function request(body: unknown, locals: Record<string, unknown> = { user }) {
  const context = createContext(new Request('https://api.konektag.eu/api/points-k/quotations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  Object.assign(context.locals, locals);
  return quotations(context);
}
const quotationWrites = () => calls.filter(c => c.doctype === 'Quotation' && c.method !== 'GET').length;

beforeEach(() => {
  vi.resetAllMocks();
  calls = []; docs = new Map(); seq = 0; rejectQuotation = null;
  sites = defaultSites();
  seedCatalog();
  process.env.MARKETPLACE_TRANSACTION_MERCHANTS = JSON.stringify({ 'konektag-fr': { site: 'EUROPE' }, 'konektag-cg': { site: 'KONEKTAG_CG' }, 'konektag-lb': { site: 'LIBAN' } });
  for (const [site, host] of Object.entries(hosts)) {
    process.env[`MARKETPLACE_FRAPPE_${site}_URL`] = `https://${host}/`;
    process.env[`MARKETPLACE_FRAPPE_${site}_API_KEY`] = 'key-' + site;
    process.env[`MARKETPLACE_FRAPPE_${site}_API_SECRET`] = 'secret-' + site;
  }
  m.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('payment_country_mappings')) {
      const rule = rules[String(values[0])];
      return { rows: rule ? [{ payment_country: rule }] : [] };
    }
    return { rows: [] };
  });
  m.lockQuery.mockResolvedValue({ rows: [] });
  m.connect.mockResolvedValue({ query: m.lockQuery, release: m.release });
  vi.stubGlobal('fetch', vi.fn(fakeFrappe));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('POST /api/points-k/quotations', () => {
  it.each([
    ['FR', 'EUR', 100, 'europe.erp.konektag.eu', 'konektag-fr', 'EUROPE'],
    ['BE', 'EUR', 37.5, 'europe.erp.konektag.eu', 'konektag-fr', 'EUROPE'],
    ['CG', 'XAF', 100_000, 'congo.erp.konektag.eu', 'konektag-cg', 'KONEKTAG_CG'],
    ['LB', 'USD', 50, 'liban.erp.konektag.eu', 'konektag-lb', 'LIBAN'],
  ])('routes %s to its site and returns the largest quantity ERPNext keeps within %s %s', async (country, currency, budget, host, slug, siteKey) => {
    const response = await request({ country, currency, budget, itemCode: 'POINTS-K' });
    expect(response.status).toBe(201);
    const body = await response.json();
    const cfg = sites[host];
    const expected = bruteForceMax(cfg, budget);
    expect(body).toMatchObject({ konektagSite: slug, site: { key: siteKey, host }, budget, customer: { created: true }, lead: { created: true } });
    expect(body.quotation).toMatchObject({ docstatus: 0, created: true, currency, itemCode: 'POINTS-K', qty: expected, rate: cfg.rate, sellingPriceList: cfg.priceList });
    expect(body.quotation.total).toBe(erpTotals(cfg, expected).total);
    expect(body.quotation.total).toBeLessThanOrEqual(budget);
    expect(erpTotals(cfg, expected + 1).total).toBeGreaterThan(budget);
    // floor(budget / HT price) ignores the taxes and overshoots the budget.
    expect(expected).toBeLessThan(Math.floor(budget / cfg.rate));
    // Only the routed site is called.
    expect(new Set(calls.map(c => c.host))).toEqual(new Set([host]));

    // ERPNext-side documents: Customer.alias, Lead.customer, Quotation to the Lead, ending on the chosen quantity.
    const [customer] = table(host, 'Customer');
    const [lead] = table(host, 'Lead');
    const [quotation] = table(host, 'Quotation');
    expect(table(host, 'Quotation')).toHaveLength(1);
    expect(customer).toMatchObject({ name: body.customer.name, alias: KEYCLOAK, customer_type: 'Individual', lead_name: lead.name });
    expect(lead).toMatchObject({ name: body.lead.name, customer: customer.name });
    expect(quotation).toMatchObject({ name: body.quotation.name, quotation_to: 'Lead', party_name: lead.name, docstatus: 0, currency, selling_price_list: cfg.priceList });
    expect(quotation.items).toEqual([expect.objectContaining({ item_code: 'POINTS-K', qty: expected, uom: 'Nos' })]);
    // The API sends no rate, tax or total: ERPNext computes them.
    const writes = (fetch as any).mock.calls.filter(([, init]: any[]) => init?.method === 'POST' || init?.method === 'PUT').map(([, init]: any[]) => JSON.parse(init.body));
    for (const write of writes) expect(Object.keys(write)).not.toEqual(expect.arrayContaining(['taxes']));
    for (const write of writes.filter((w: any) => w.items)) for (const row of write.items) expect(Object.keys(row).sort()).toEqual(['item_code', 'qty', 'uom']);
    expect(quotationWrites()).toBeLessThanOrEqual(6);
  });

  it('uses the selected country, not the residence country recorded at registration', async () => {
    const response = await request({ country: 'FR', currency: 'EUR', budget: 10, itemCode: 'POINTS-K' }, { user: { ...user, legal_country: 'CG' } });
    expect(response.status).toBe(201);
    expect(new Set(calls.map(c => c.host))).toEqual(new Set(['europe.erp.konektag.eu']));
  });

  it('is idempotent: a repeated request reuses the Customer, the Lead and the draft Quotation', async () => {
    const input = { country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' };
    const first = await (await request(input)).json();
    const again = await request(input);
    expect(again.status).toBe(200);
    const second = await again.json();
    expect(second.customer).toEqual({ name: first.customer.name, created: false });
    expect(second.lead).toEqual({ name: first.lead.name, created: false });
    expect(second.quotation).toMatchObject({ name: first.quotation.name, created: false, qty: first.quotation.qty, total: first.quotation.total });
    const host = 'europe.erp.konektag.eu';
    expect([table(host, 'Customer'), table(host, 'Lead'), table(host, 'Quotation')].map(t => t.length)).toEqual([1, 1, 1]);
    // A new budget updates the same draft.
    const third = await (await request({ ...input, budget: 250 })).json();
    expect(third.quotation).toMatchObject({ name: first.quotation.name, qty: bruteForceMax(sites[host], 250) });
    expect(table(host, 'Quotation')).toHaveLength(1);
    // Calls are serialized per user and site.
    expect(m.lockQuery).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['points-k-quotation|EUROPE|' + KEYCLOAK]);
    expect(m.release).toHaveBeenCalledTimes(3);
  });

  it('reuses only the Customer whose alias is the authenticated Keycloak subject', async () => {
    const host = 'europe.erp.konektag.eu';
    table(host, 'Customer').push({ name: 'CUST-OTHER', alias: 'kc-someone-else', disabled: 0 }, { name: 'CUST-ADA', alias: KEYCLOAK, disabled: 0 });
    table(host, 'Lead').push({ name: 'LEAD-OLD', customer: 'CUST-ADA', status: 'Do Not Contact', disabled: 0 });
    const body = await (await request({ country: 'FR', currency: 'EUR', budget: 12, itemCode: 'POINTS-K' })).json();
    expect(body.customer).toEqual({ name: 'CUST-ADA', created: false });
    expect(body.lead.created).toBe(true);
    expect(table(host, 'Lead').find(l => l.name === body.lead.name)).toMatchObject({ customer: 'CUST-ADA' });
  });

  it('recovers a Customer created concurrently with the same alias', async () => {
    const host = 'europe.erp.konektag.eu';
    const base = (fetch as any).getMockImplementation();
    let raced = false;
    (fetch as any).mockImplementation(async (input: string, init: RequestInit = {}) => {
      if (!raced && init.method === 'POST' && String(input).includes('/Customer')) {
        raced = true;
        table(host, 'Customer').push({ name: 'CUST-RACE', alias: KEYCLOAK, disabled: 0 });
      }
      return base(input, init);
    });
    const body = await (await request({ country: 'FR', currency: 'EUR', budget: 5, itemCode: 'POINTS-K' })).json();
    expect(body.customer).toEqual({ name: 'CUST-RACE', created: false });
    expect(table(host, 'Customer')).toHaveLength(1);
  });

  describe('Customer <-> Lead link usable by make_sales_order (ERPNext 16.54.0)', () => {
    const host = 'europe.erp.konektag.eu';
    const input = { country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' };

    it('converts the Quotation to the same Customer, without a second one, alias kept', async () => {
      const body = await (await request(input)).json();
      // The link is set before the Quotation exists: it is still addressed to the Lead.
      expect(table(host, 'Quotation')[0]).toMatchObject({ quotation_to: 'Lead', party_name: body.lead.name });
      expect(table(host, 'Lead')[0]).toMatchObject({ customer: body.customer.name, status: 'Converted' });
      const converted = makeSalesOrderCustomer(host, body.quotation.name);
      expect(converted).toMatchObject({ name: body.customer.name, alias: KEYCLOAK, lead_name: body.lead.name });
      expect(table(host, 'Customer')).toHaveLength(1);
      // The Customer write carries lead_name only.
      const customerWrites = (fetch as any).mock.calls
        .filter(([url, init]: any[]) => init?.method === 'PUT' && String(url).includes('/resource/Customer/'))
        .map(([, init]: any[]) => JSON.parse(init.body));
      expect(customerWrites).toEqual([{ lead_name: body.lead.name }]);
      // A repeated request keeps everything and writes no link again.
      calls = [];
      const again = await (await request(input)).json();
      expect(again).toMatchObject({ customer: { name: body.customer.name, created: false }, lead: { name: body.lead.name, created: false }, quotation: { name: body.quotation.name } });
      expect(calls.filter(c => c.method === 'PUT' && c.doctype !== 'Quotation')).toEqual([]);
    });

    it('links a Lead created before the fix (Lead.customer only) and converts to the same Customer', async () => {
      table(host, 'Customer').push({ name: 'CUST-ADA', alias: KEYCLOAK, disabled: 0, lead_name: null });
      table(host, 'Lead').push({ name: 'LEAD-ADA', customer: 'CUST-ADA', status: 'Lead', disabled: 0, lead_name: 'Ada' });
      const body = await (await request(input)).json();
      expect(body).toMatchObject({ customer: { name: 'CUST-ADA', created: false }, lead: { name: 'LEAD-ADA', created: false } });
      expect(makeSalesOrderCustomer(host, body.quotation.name)).toMatchObject({ name: 'CUST-ADA', alias: KEYCLOAK });
      expect(table(host, 'Customer')).toHaveLength(1);
    });

    it('uses the Lead the Customer was converted from, and links it back', async () => {
      table(host, 'Customer').push({ name: 'CUST-ADA', alias: KEYCLOAK, disabled: 0, lead_name: 'LEAD-SALES' });
      table(host, 'Lead').push(
        { name: 'LEAD-SALES', customer: null, status: 'Converted', disabled: 0, lead_name: 'Ada' },
        { name: 'LEAD-OTHER', customer: 'CUST-ADA', status: 'Lead', disabled: 0, lead_name: 'Ada' },
      );
      const body = await (await request(input)).json();
      expect(body.lead).toEqual({ name: 'LEAD-SALES', created: false });
      expect(table(host, 'Lead')[0].customer).toBe('CUST-ADA');
      expect(table(host, 'Customer')[0].lead_name).toBe('LEAD-SALES');
      expect(makeSalesOrderCustomer(host, body.quotation.name).name).toBe('CUST-ADA');
    });

    it('does not reuse a Lead already converted to another Customer', async () => {
      table(host, 'Customer').push({ name: 'CUST-ADA', alias: KEYCLOAK, disabled: 0, lead_name: null }, { name: 'CUST-X', alias: null, disabled: 0, lead_name: 'LEAD-X' });
      table(host, 'Lead').push({ name: 'LEAD-X', customer: 'CUST-ADA', status: 'Converted', disabled: 0 });
      const body = await (await request(input)).json();
      expect(body.lead).toMatchObject({ created: true });
      expect(body.lead.name).not.toBe('LEAD-X');
      expect(makeSalesOrderCustomer(host, body.quotation.name).name).toBe('CUST-ADA');
    });

    it.each([
      ['the Customer’s Lead belongs to another Customer', [{ name: 'LEAD-SALES', customer: 'CUST-X', status: 'Converted', disabled: 0 }], [], 502, 'CUSTOMER_IDENTITY_MISMATCH'],
      ['another Customer claims the same Lead', [{ name: 'LEAD-SALES', customer: 'CUST-ADA', status: 'Converted', disabled: 0 }], [{ name: 'CUST-X', alias: null, disabled: 0, lead_name: 'LEAD-SALES' }], 502, 'CUSTOMER_IDENTITY_MISMATCH'],
      ['the Customer’s Lead is disabled', [{ name: 'LEAD-SALES', customer: 'CUST-ADA', status: 'Converted', disabled: 1 }], [], 409, 'CUSTOMER_DISABLED'],
    ])('refuses when %s, before any Quotation', async (_label, leads, others, status, error) => {
      table(host, 'Customer').push({ name: 'CUST-ADA', alias: KEYCLOAK, disabled: 0, lead_name: 'LEAD-SALES' }, ...others);
      table(host, 'Lead').push(...leads);
      const response = await request(input);
      expect([response.status, (await response.json()).error]).toEqual([status, error]);
      expect(table(host, 'Quotation')).toEqual([]);
    });
  });

  it('follows the rounding ERPNext applies (rounded_total, or grand_total when rounding is disabled)', async () => {
    const host = 'europe.erp.konektag.eu';
    // Without a smallest fraction ERPNext rounds to whole units: 83 K = 99.60 -> 100.
    sites[host].fraction = 0;
    let body = await (await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' })).json();
    expect(body.quotation).toMatchObject({ qty: bruteForceMax(sites[host], 100), grandTotal: 99.6, roundedTotal: 100, total: 100, roundedTotalDisabled: false });
    sites[host].disableRounded = 1;
    body = await (await request({ country: 'FR', currency: 'EUR', budget: 99.5, itemCode: 'POINTS-K' })).json();
    expect(body.quotation).toMatchObject({ qty: 82, grandTotal: 98.4, total: 98.4, roundedTotalDisabled: true });
  });

  it('finds the maximum with fixed charges and taxes the API does not know', async () => {
    const host = 'liban.erp.konektag.eu';
    sites[host].taxes = [{ charge_type: 'On Net Total', rate: 11, description: 'VAT' }, { charge_type: 'Actual', amount: 2.5, description: 'Stamp' }];
    for (const budget of [3.61, 3.62, 10, 1234.56, 99_999]) {
      docs.delete(host + '|Quotation');
      const body = await (await request({ country: 'LB', currency: 'USD', budget, itemCode: 'POINTS-K' })).json();
      expect(body.quotation.qty).toBe(bruteForceMax(sites[host], budget));
    }
  });

  it('matches a brute-force scan over random prices, taxes and budgets', async () => {
    const host = 'congo.erp.konektag.eu';
    let state = 42;
    const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 25; i++) {
      docs.delete(host + '|Quotation');
      sites[host].taxes = [{ charge_type: 'On Net Total', rate: Math.round(random() * 3000) / 100, description: 'T' }];
      if (random() < 0.3) sites[host].taxes.push({ charge_type: 'Actual', amount: Math.round(random() * 2000), description: 'F' });
      const budget = Math.round(1000 + random() * 2_000_000);
      const expected = bruteForceMax(sites[host], budget);
      calls = [];
      const response = await request({ country: 'CG', currency: 'XAF', budget, itemCode: 'POINTS-K' });
      if (expected === 0) { expect(response.status).toBe(422); continue; }
      const body = await response.json();
      expect(body.quotation.qty).toBe(expected);
      expect(quotationWrites()).toBeLessThanOrEqual(12);
    }
  });

  it('refuses a budget that buys no whole K, with ERPNext’s total for one', async () => {
    const response = await request({ country: 'FR', currency: 'EUR', budget: 1, itemCode: 'POINTS-K' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'NO_PURCHASE_POSSIBLE', budget: 1, totalForOne: 1.2 });
  });

  it.each([
    ['a currency without price on the site', { country: 'FR', currency: 'USD' }, 422, 'PRICE_NOT_FOUND'],
    ['an item unknown to the site', { country: 'FR', currency: 'EUR', itemCode: 'GIFT-CARD' }, 422, 'ITEM_NOT_FOUND'],
    ['a country without rule', { country: 'US', currency: 'USD' }, 422, 'COUNTRY_RULE_NOT_FOUND'],
  ])('refuses %s', async (_label, override, status, error) => {
    const response = await request({ budget: 100, itemCode: 'POINTS-K', ...override });
    expect(response.status).toBe(status);
    expect((await response.json()).error).toBe(error);
    expect(calls.filter(c => c.method !== 'GET')).toEqual([]);
  });

  it('refuses an invalid or ambiguous price rather than inventing one', async () => {
    const host = 'europe.erp.konektag.eu';
    table(host, 'Item Price')[0].price_list_rate = 0;
    let response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect([response.status, (await response.json()).error]).toEqual([422, 'PRICE_INVALID']);
    table(host, 'Item Price')[0].price_list_rate = 1;
    table(host, 'Price List').push({ name: 'Promo EUR', currency: 'EUR', enabled: 1, selling: 1 });
    table(host, 'Item Price').push({ name: 'IP-PROMO', item_code: 'POINTS-K', price_list: 'Promo EUR', price_list_rate: 0.9, currency: 'EUR', selling: 1, uom: 'Nos', customer: null });
    response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect([response.status, (await response.json()).error]).toEqual([503, 'PRICE_AMBIGUOUS']);
    table(host, 'Price List')[1].enabled = 0;
    response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect(response.status).toBe(201);
    expect(calls.filter(c => c.method !== 'GET').length).toBeGreaterThan(0);
  });

  it('refuses a disabled item or customer', async () => {
    const host = 'europe.erp.konektag.eu';
    table(host, 'Item')[0].is_sales_item = 0;
    let response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect([response.status, (await response.json()).error]).toEqual([422, 'ITEM_NOT_SALEABLE']);
    table(host, 'Item')[0].is_sales_item = 1;
    table(host, 'Customer').push({ name: 'CUST-ADA', alias: KEYCLOAK, disabled: 1 });
    response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect([response.status, (await response.json()).error]).toEqual([409, 'CUSTOMER_DISABLED']);
  });

  it('requires an authenticated user carrying a Keycloak subject', async () => {
    let response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' }, { user: undefined });
    expect(response.status).toBe(401);
    response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' }, { user: { ...user, keycloak_id: '' } });
    expect([response.status, (await response.json()).error]).toEqual([401, 'KEYCLOAK_IDENTITY_MISSING']);
    expect(calls).toEqual([]);
  });

  it.each([
    [{ country: 'FR', currency: 'EUR', budget: 0, itemCode: 'POINTS-K' }],
    [{ country: 'FR', currency: 'EUR', budget: '100', itemCode: 'POINTS-K' }],
    [{ country: 'FR', currency: 'eur', budget: 100, itemCode: 'POINTS-K' }],
    [{ country: 'FR', currency: 'EUR', budget: 100 }],
    [{ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K', qty: 3 }],
  ])('rejects malformed input %j', async (body) => {
    const response = await request(body);
    expect([response.status, (await response.json()).error]).toEqual([400, 'INVALID_REQUEST']);
    expect(calls).toEqual([]);
  });

  it('reports an ERPNext rejection without leaking its message', async () => {
    rejectQuotation = { status: 417, body: { exc_type: 'ValidationError', exception: 'secret internal detail' } };
    const response = await request({ country: 'FR', currency: 'EUR', budget: 100, itemCode: 'POINTS-K' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'ERPNEXT_REJECTED' });
  });

  it('reports a site without credentials as a configuration error', async () => {
    delete process.env.MARKETPLACE_FRAPPE_LIBAN_API_SECRET;
    const response = await request({ country: 'LB', currency: 'USD', budget: 100, itemCode: 'POINTS-K' });
    expect([response.status, (await response.json()).error]).toEqual([503, 'KONEKTAG_SITE_NOT_CONFIGURED']);
  });
});
