import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), activation: vi.fn(), invoices: {} as Record<string, Record<string, any>> }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: mocks.activation } }));
vi.mock('../../src/application/marketplace-transactions/frappe-site.ts', async (original) => ({
  ...(await original<any>()),
  frappeSite: (key: string) => ({ get: async (_: string, name: string) => {
    const doc = mocks.invoices[key]?.[name];
    if (!doc) { const { FrappeSiteError } = await original<any>(); throw new FrappeSiteError('SITE_REJECTED', 404); }
    return doc;
  } }),
}));
import { GET, POST } from '../../src/api/routes/integrations/frappe/payment-links.ts';
import { POST as LEGACY_POST } from '../../src/api/routes/pay/payment-links.ts';

const KONEKTAG_CONGO = '11111111-1111-4111-8111-111111111111';
const RESTAURANT = '22222222-2222-4222-8222-222222222222';
const tokens = { CONGO: 'c'.repeat(40), RESTODEMO: 'r'.repeat(40) };
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
process.env.LINK_PAY_FRAPPE_SITES = JSON.stringify({
  CONGO: { tokenSha256: sha(tokens.CONGO), companies: { 'konektag congo': KONEKTAG_CONGO } },
  RESTODEMO: { tokenSha256: sha(tokens.RESTODEMO), companies: { 'Le Jardin du Fleuve': RESTAURANT } },
});
const invoice = (company: string, outstanding = 6500, extra: Record<string, unknown> = {}) => ({
  name: 'ACC-SINV-2026-00012', company, docstatus: 1, is_return: 0, is_pos: 0, currency: 'XAF',
  party_account_currency: 'XAF', outstanding_amount: outstanding, ...extra });
let links: any[];
const key = (n: string) => n.repeat(64).slice(0, 64);
const request = (site: keyof typeof tokens | 'NONE', body: unknown, attempt = key('a'), token?: string) => POST({
  request: new Request('http://x/api/integrations/frappe/payment-links', { method: 'POST', body: JSON.stringify(body), headers: {
    'X-Konektag-Frappe-Site': site, 'X-Konektag-Frappe-Token': token ?? (tokens as any)[site] ?? 'x'.repeat(40), 'X-Idempotency-Key': attempt } }),
  locals: {},
} as any);
const list = (site: keyof typeof tokens, invoiceName: string) => GET({
  request: new Request('http://x', { headers: { 'X-Konektag-Frappe-Site': site, 'X-Konektag-Frappe-Token': tokens[site] } }),
  url: new URL('http://x/api/integrations/frappe/payment-links?invoice=' + encodeURIComponent(invoiceName)), locals: {},
} as any);

beforeEach(() => {
  vi.resetAllMocks();
  links = [];
  mocks.invoices = { CONGO: { 'ACC-SINV-2026-00012': invoice('konektag congo') },
                     RESTODEMO: { 'ACC-SINV-2026-00012': invoice('Le Jardin du Fleuve') } };
  mocks.activation.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('SELECT country FROM konektag.merchant_profiles')) return { rows: [{ country: 'CG' }] };
    if (sql.includes('FROM konektag.exchange_rates')) return { rows: [{ id: '33333333-3333-4333-8333-333333333333', rate: '0.0015243902439024',
      points_k_matrix_version: 7, valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2027-01-01T00:00:00.000Z', points_k_approval_source: 'TEST' }] };
    if (sql.includes('INSERT INTO konektag.checkout_intents')) {
      if (links.some(l => l.core_transaction_id === params[9])) return { rows: [] };
      const row = { merchant_profile_id: params[1], quantity_k: params[2], currency: params[3], service_description: params[4],
        expiration: params[5], public_id: params[6], reference: params[7], amount: params[8], core_transaction_id: params[9],
        quote_valuation: JSON.parse(params[10]), status: 'ISSUED', business_name: 'M' };
      links.push(row); return { rows: [row] };
    }
    if (sql.includes('WHERE core_transaction_id=$1 AND merchant_profile_id=$2'))
      return { rows: links.filter(l => l.core_transaction_id === params[0] && l.merchant_profile_id === params[1]) };
    if (sql.includes('ci.core_transaction_id LIKE $3')) {
      const prefix = String(params[2]).slice(0, -1);
      return { rows: links.filter(l => params[0].includes(l.merchant_profile_id) && l.reference === params[1] && String(l.core_transaction_id).startsWith(prefix)) };
    }
    if (sql.includes('SELECT business_name')) return { rows: [{ business_name: 'M' }] };
    throw new Error('Unexpected SQL ' + sql);
  });
});

describe('Link Pay issued by an authenticated Frappe site', () => {
  it('refuses an unknown site or a wrong token before any read', async () => {
    expect((await request('NONE', { invoice: 'ACC-SINV-2026-00012' })).status).toBe(401);
    expect((await request('CONGO', { invoice: 'ACC-SINV-2026-00012' }, key('a'), 'w'.repeat(40))).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('collects a Konektag Congo sale for Konektag Congo, from the invoice read on Congo', async () => {
    const response = await request('CONGO', { invoice: 'ACC-SINV-2026-00012', merchantProfileId: RESTAURANT, amount: '1' });
    expect(response.status).toBe(201);
    const { link } = await response.json();
    expect(link).toMatchObject({ merchant: KONEKTAG_CONGO, amount: 6500, currency: 'XAF', reference: 'ACC-SINV-2026-00012',
      origin: { site: 'CONGO', invoice: 'ACC-SINV-2026-00012' } });
    expect(links[0].core_transaction_id).toBe('frappe-site:CONGO:' + key('a'));
  });

  it('collects a merchant sale for that merchant, from its own site', async () => {
    const { link } = await (await request('RESTODEMO', { invoice: 'ACC-SINV-2026-00012' })).json();
    expect(link.merchant).toBe(RESTAURANT);
  });

  it('keeps two sites with the same invoice number, amount and key isolated', async () => {
    const congo = (await (await request('CONGO', { invoice: 'ACC-SINV-2026-00012' })).json()).link;
    const resto = (await (await request('RESTODEMO', { invoice: 'ACC-SINV-2026-00012' })).json()).link;
    expect(congo.name).not.toBe(resto.name);
    const congoList = (await (await list('CONGO', 'ACC-SINV-2026-00012')).json()).links;
    const restoList = (await (await list('RESTODEMO', 'ACC-SINV-2026-00012')).json()).links;
    expect(congoList.map((l: any) => l.name)).toEqual([congo.name]);
    expect(restoList.map((l: any) => l.name)).toEqual([resto.name]);
    expect(congoList[0].origin).toEqual({ site: 'CONGO', invoice: 'ACC-SINV-2026-00012' });
  });

  it('replays the same attempt to the same link and exposes the operation once consumed', async () => {
    const first = (await (await request('CONGO', { invoice: 'ACC-SINV-2026-00012' })).json()).link;
    const replay = await request('CONGO', { invoice: 'ACC-SINV-2026-00012' });
    expect(replay.status).toBe(201);
    expect((await replay.json()).link.name).toBe(first.name);
    expect(links).toHaveLength(1);
    Object.assign(links[0], { status: 'CONSUMED', k_operation_id: '44444444-4444-4444-8444-444444444444', consumed_at: '2026-11-10T10:00:00.000Z' });
    const [paid] = (await (await list('CONGO', 'ACC-SINV-2026-00012')).json()).links;
    expect(paid).toMatchObject({ status: 'Used', operationId: '44444444-4444-4444-8444-444444444444' });
  });

  it('refuses a key replayed after the balance changed, settled, unrouted or unsubmitted invoices', async () => {
    await request('CONGO', { invoice: 'ACC-SINV-2026-00012' });
    mocks.invoices.CONGO['ACC-SINV-2026-00012'].outstanding_amount = 5000;
    expect((await request('CONGO', { invoice: 'ACC-SINV-2026-00012' })).status).toBe(409);
    mocks.invoices.CONGO['X-1'] = invoice('konektag congo', 0, { name: 'X-1' });
    mocks.invoices.CONGO['X-2'] = invoice('another company', 100, { name: 'X-2' });
    mocks.invoices.CONGO['X-3'] = invoice('konektag congo', 100, { name: 'X-3', docstatus: 0 });
    expect((await request('CONGO', { invoice: 'X-1' }, key('b'))).status).toBe(409);
    expect((await request('CONGO', { invoice: 'X-2' }, key('c'))).status).toBe(403);
    expect((await request('CONGO', { invoice: 'X-3' }, key('d'))).status).toBe(409);
    expect((await request('CONGO', { invoice: 'MISSING' }, key('e'))).status).toBe(404);
  });

  it('leaves the existing user-key route unchanged', async () => {
    const response = await LEGACY_POST({ request: new Request('http://x', { method: 'POST', body: JSON.stringify({ amount: '6500' }) }), locals: {} } as any);
    expect(response.status).toBe(401);
  });
});
