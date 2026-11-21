import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { GET as availabilityRoute } from '../../src/api/routes/public/bookings/availability.ts';
import { POST as bookingRoute } from '../../src/api/routes/public/bookings/index.ts';
import { PATCH as changeBookingRoute } from '../../src/api/routes/public/bookings/[name].ts';
import { POST as quotationRoute } from '../../src/api/routes/public/quotations/index.ts';
import { GET as quotationStatusRoute } from '../../src/api/routes/public/quotations/[name].ts';
import type { CommerceDeps } from '../../src/application/public-website/commerce.ts';

const calls: { path: string; body: any; authorization: string | null }[] = [];
let abmInstalled = true;
const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input)); const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ path: url.pathname, body, authorization: new Headers(init?.headers).get('authorization') });
  if (url.pathname.endsWith('/konektag_abm.api.availability')) {
    if (!abmInstalled) return Response.json({ exc_type: 'DoesNotExistError', exception: 'Failed to get method for command konektag_abm.api.availability because No module named konektag_abm' }, { status: 404 });
    return Response.json({ message: { available: true, occupied: false } });
  }
  if (url.pathname.endsWith('/konektag_abm.api.create_booking')) return Response.json({ message: { name: 'ABM-BKG-1', resource: body.resource ?? body.payload.resource, starts_at: body.payload.starts_at, ends_at: body.payload.ends_at, status: 'Request' } });
  if (url.pathname.endsWith('/konektag_abm.api.transition')) return Response.json({ message: { name: body.name, resource: 'SALLE-1', starts_at: '2026-12-01T10:00:00Z', ends_at: '2026-12-01T12:00:00Z', status: body.target_status } });
  if (url.pathname === '/api/resource/Quotation' && init?.method === 'POST') return Response.json({ data: { name: 'QTN-1', docstatus: 0, currency: body.currency, selling_price_list: body.selling_price_list, net_total: 100000, total_taxes_and_charges: 18500, grand_total: 118500 } });
  if (url.pathname === '/api/resource/Quotation/QTN-1') return Response.json({ data: { name: 'QTN-1', docstatus: 0, currency: 'XAF', selling_price_list: 'Tarifs publics', net_total: 100000, total_taxes_and_charges: 18500, grand_total: 118500, owner: 'private@example.test' } });
  throw new Error(`unexpected ${url.pathname}`);
}) as typeof fetch;

const env = {
  KONEKTAG_FRAPPE_SITE_REGISTRY: JSON.stringify([
    { tenantId: 'abm-demo', frappeSiteId: 'abm-demo', country: 'CG', kind: 'CUSTOMER', enabled: true, site: 'ABMDEMO', publicScopes: ['booking:read', 'booking:write', 'quotation:write'] },
    { tenantId: 'rocher-des-ages', frappeSiteId: 'rocher-des-ages', country: 'CG', kind: 'CUSTOMER', enabled: true, site: 'RDA', publicScopes: ['booking:read', 'booking:write'] },
  ]),
  PUBLIC_COMMERCE_SITES: JSON.stringify({ 'abm-demo': { booking: true, quotation: true }, 'rocher-des-ages': { booking: true } }),
  PUBLIC_COMMERCE_TOKEN_SECRET: 'a'.repeat(64),
  MARKETPLACE_FRAPPE_ABMDEMO_URL: 'https://abmdemo.erp.konektag.eu/', MARKETPLACE_FRAPPE_ABMDEMO_API_KEY: 'server-key', MARKETPLACE_FRAPPE_ABMDEMO_API_SECRET: 'server-secret',
  MARKETPLACE_FRAPPE_RDA_URL: 'https://rda.erp.konektag.eu/', MARKETPLACE_FRAPPE_RDA_API_KEY: 'server-key', MARKETPLACE_FRAPPE_RDA_API_SECRET: 'server-secret',
} as NodeJS.ProcessEnv;
let deps: CommerceDeps;
const context = (url: string, init?: RequestInit, params: Record<string, string> = {}) => createContext(new Request(url, init), params);

beforeEach(() => { calls.length = 0; abmInstalled = true; deps = { env, fetchImpl, now: () => new Date('2026-11-21T12:00:00Z') }; });

describe('public Quotation and Booking façade', () => {
  it('returns aggregate availability through the exact ABM method with server credentials', async () => {
    const response = await availabilityRoute(context('https://api.test/api/public/bookings/availability?site=abm-demo&resource=SALLE-1&startsAt=2026-12-01T10%3A00%3A00Z&endsAt=2026-12-01T12%3A00%3A00Z'), deps);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ available: true, occupied: false });
    expect(calls[0]).toMatchObject({ path: '/api/method/konektag_abm.api.availability', authorization: 'token server-key:server-secret' });
  });

  it('creates an idempotent option and signs a capability used for cancellation', async () => {
    const body = { site: 'abm-demo', resource: 'SALLE-1', startsAt: '2026-12-01T10:00:00Z', endsAt: '2026-12-01T12:00:00Z', mode: 'OPTION' };
    const created = await bookingRoute(context('https://api.test/api/public/bookings', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'visitor-operation-1' }, body: JSON.stringify(body) }), deps);
    expect(created.status).toBe(201); const result = await created.json(); expect(result).toMatchObject({ reference: 'ABM-BKG-1', status: 'Option' });
    expect(calls.map(v => v.path)).toEqual(['/api/method/konektag_abm.api.create_booking', '/api/method/konektag_abm.api.transition']);
    expect(calls[0].body).toMatchObject({ idempotency_key: 'visitor-operation-1' });
    const cancelled = await changeBookingRoute(context('https://api.test/api/public/bookings/ABM-BKG-1?site=abm-demo', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'CANCEL', accessToken: result.accessToken }) }, { name: 'ABM-BKG-1' }), deps);
    expect(cancelled.status).toBe(200); expect(await cancelled.json()).toMatchObject({ status: 'Cancelled' });
  });

  it('rejects a forged visitor capability before any ABM mutation', async () => {
    const response = await changeBookingRoute(context('https://api.test/api/public/bookings/ABM-BKG-1?site=abm-demo', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'CANCEL', accessToken: `${'x'.repeat(40)}.${'y'.repeat(43)}` }) }, { name: 'ABM-BKG-1' }), deps);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'ACCESS_DENIED' }); expect(calls).toHaveLength(0);
  });

  it('returns FEATURE_UNAVAILABLE when konektag-abm is absent on RDA', async () => {
    abmInstalled = false;
    const response = await availabilityRoute(context('https://api.test/api/public/bookings/availability?site=rocher-des-ages&resource=SALLE-1&startsAt=2026-12-01T10%3A00%3A00Z&endsAt=2026-12-01T12%3A00%3A00Z'), deps);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'FEATURE_UNAVAILABLE' });
  });

  it('creates a native draft without accepting browser rates, tax or totals', async () => {
    const response = await quotationRoute(context('https://api.test/api/public/quotations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: 'abm-demo', lead: 'LEAD-1', currency: 'XAF', priceList: 'Tarifs publics', lines: [{ itemCode: 'RDA-LOC-EPHRAIM', quantity: 2 }] }) }), deps);
    expect(response.status).toBe(201); const result = await response.json(); expect(result).toMatchObject({ reference: 'QTN-1', status: 'DRAFT', grandTotal: 118500 });
    expect(calls[0].body).toMatchObject({ doctype: 'Quotation', quotation_to: 'Lead', party_name: 'LEAD-1', currency: 'XAF', selling_price_list: 'Tarifs publics', items: [{ item_code: 'RDA-LOC-EPHRAIM', qty: 2 }] });
    expect(calls[0].body).not.toHaveProperty('grand_total'); expect(calls[0].body.items[0]).not.toHaveProperty('rate');
    const status = await quotationStatusRoute(context(`https://api.test/api/public/quotations/QTN-1?site=abm-demo&accessToken=${encodeURIComponent(result.accessToken)}`, {}, { name: 'QTN-1' }), deps);
    expect(status.status).toBe(200); const publicStatus = await status.json(); expect(publicStatus).toMatchObject({ reference: 'QTN-1', status: 'DRAFT', grandTotal: 118500 }); expect(publicStatus).not.toHaveProperty('owner');
  });

  it('rejects all browser totals as unknown fields', async () => {
    const response = await quotationRoute(context('https://api.test/api/public/quotations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: 'abm-demo', lead: 'LEAD-1', currency: 'XAF', priceList: 'Tarifs publics', grandTotal: 1, lines: [{ itemCode: 'ITEM-1', quantity: 1 }] }) }), deps);
    expect(response.status).toBe(422); expect(calls).toHaveLength(0);
  });
});
