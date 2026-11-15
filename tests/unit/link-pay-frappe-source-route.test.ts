import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));
const mocks = vi.hoisted(() => ({ invoice: vi.fn(), restaurant: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock('../../src/application/link-pay/frappe-site-routing.ts', async original => ({
  ...await original<any>(), authenticateSite: () => ({ key: 'RESTODEMO' }),
  validateRestaurantRouting: () => ({ networkSite: 'CONGO', beneficiarySite: 'RESTODEMO' }),
  validateRouting: () => ({ networkSite: 'CONGO', beneficiarySite: 'RESTODEMO' }),
  beneficiaryTerms: async () => ({ currency: 'XAF', feeMode: 'EXEMPT', feeRateBps: 0 }), verifyInvoice: mocks.invoice,
}));
vi.mock('../../src/application/link-pay/restaurant-source.ts', () => ({ verifyRestaurantSource: mocks.restaurant }));
vi.mock('../../src/application/link-pay/network-link-service.ts', () => ({ networkLinkService: { create: mocks.create, revokeSource: mocks.revoke } }));
import { POST, DELETE } from '../../src/api/routes/integrations/frappe/payment-links.ts';
const request = (method: string, body: unknown) => ({ request: new Request('http://x', { method,
  headers: { 'x-idempotency-key': 'a'.repeat(64) }, body: JSON.stringify(body) }) }) as any;
beforeEach(() => { vi.resetAllMocks(); mocks.create.mockResolvedValue({ url_slug: 'link1' }); });
it('preserves existing invoice issuance without a restaurant RPC', async () => {
  mocks.invoice.mockResolvedValue({ name: 'INV-1', company: 'M', currency: 'XAF', amountMajor: '800' });
  const response = await POST(request('POST', { invoice: 'INV-1' }));
  expect(response.status).toBe(201); expect(mocks.restaurant).not.toHaveBeenCalled();
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('source');
});
it('issues the verified restaurant amount and expiry, ignoring any browser amount', async () => {
  const source = { attempt: '11111111-1111-4111-8111-111111111111', posProfile: 'Restaurant', fingerprint: 'b'.repeat(64) };
  const expiration = new Date('2026-11-16T10:00:00Z');
  mocks.restaurant.mockResolvedValue({ source, expiration, invoice: { name: 'ORD-1', currency: 'XAF', amountMajor: '800', company: 'M' } });
  expect((await POST(request('POST', { sourceType: 'restaurant_order', sourceAttempt: source.attempt, posProfile: source.posProfile, amount: 1 }))).status).toBe(201);
  expect(mocks.invoice).not.toHaveBeenCalled();
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ source, expiration, invoice: { amountMajor: '800' } });
});
it('rejects ambiguous invoice/source issuance and delegates scoped cancellation', async () => {
  expect((await POST(request('POST', { sourceType: 'restaurant_order', invoice: 'INV-1' }))).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.revoke.mockResolvedValue({ revoked: true });
  expect((await DELETE(request('DELETE', { sourceAttempt: 'attempt1', posProfile: 'Restaurant' }))).status).toBe(200);
  expect(mocks.revoke).toHaveBeenCalledWith('RESTODEMO', 'attempt1', 'Restaurant');
});
