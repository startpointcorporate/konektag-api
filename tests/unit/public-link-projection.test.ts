import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/link-pay/network-link-service.ts', () => ({ networkLinkService: { getBySlug: mocks.get } }));
import { GET } from '../../src/api/routes/pay/payment-links.ts';
import { POST as resume } from '../../src/api/routes/pay/payment-links/[slug]/resume.ts';
const expiration = new Date(Date.now() + 86400000).toISOString();
const row = { business_name: 'Marchand public', amount: '6560', currency: 'XAF', quantity_k: '10', service_description: 'Commande', reference: 'REF-42', expiration, status: 'ISSUED',
  payer_identity: 'SECRET_EMAIL', merchant_profile_id: 'SECRET_UUID', token_hash: 'SECRET_TOKEN', quote_valuation: { private: true } };
const get = (user?: any, slug = 'abc123') => GET({ url: new URL(`https://test.local/api/pay/payment-links?slug=${slug}`), locals: { user } } as any);
beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue({ rows: [row] }); });
it('returns only the public projection and never mutates state', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ links: [{ status: 'Active', etablissement: 'Marchand public', amount: 6560, currency: 'XAF', quantityK: 10, description: 'Commande', reference: 'REF-42', expires_at: expiration }] });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls[0][0]).toMatch(/^SELECT /);
  // Network links only: the beneficiary is named by its network, never read from merchant profiles.
  expect(mocks.query.mock.calls[0][0]).toContain('JOIN konektag.link_pay_network_links');
  expect(mocks.query.mock.calls[0][0]).not.toContain('merchant_profiles');
  expect(mocks.query.mock.calls[0][1]).toEqual(['abc123']);
});
it.each([['CONSUMED', 'Used'], ['EXPIRED', 'Expired']])('returns only a terminal state for %s', async (status, publicStatus) => {
  mocks.query.mockResolvedValue({ rows: [{ ...row, status }] });
  expect(await (await get()).json()).toEqual({ links: [{ status: publicStatus }] });
});
it('handles elapsed expiration and missing links', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, expiration: '2000-01-01' }] });
  expect(await (await get()).json()).toEqual({ links: [{ status: 'Expired' }] });
  mocks.query.mockResolvedValueOnce({ rows: [] });
  expect(await (await get()).json()).toEqual({ links: [] });
});
it('does not expose an ERP identity when the business name is absent', async () => {
  mocks.query.mockResolvedValue({ rows: [{ ...row, business_name: null }] });
  expect(await (await get()).text()).not.toContain('SECRET');
});
it('does not expose internal DB errors', async () => {
  mocks.query.mockRejectedValueOnce(new Error('SECRET database detail'));
  const response = await get();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'LINK_UNAVAILABLE' });
});
it('retains the authenticated single-Link contract', async () => {
  const visible = { name: 'abc123', beneficiary: { site: 'CONGO', name: 'Konektag Congo' }, valuation: { proofHash: 'proof' } };
  mocks.get.mockResolvedValueOnce({ ...visible, checkoutIntentId: 'INTERNAL_ID' });
  expect(await (await get({ id: 'payer' })).json()).toEqual({ links: [visible] });
  expect(mocks.query).not.toHaveBeenCalled();
});
it('retires the merchant list', async () => {
  const response = await GET({ url: new URL('https://test.local/api/pay/payment-links'), locals: { user: { id: 'merchant' } } } as any);
  expect([response.status, await response.json()]).toEqual([410, { error: 'LINK_PAY_MERCHANT_PROFILE_RETIRED' }]);
  expect(mocks.query).not.toHaveBeenCalled();
});
it('refuses anonymous resume without writing a pending payment', async () => {
  expect((await resume({ locals: {}, params: { slug: 'abc123' } } as any)).status).toBe(401);
  expect(mocks.query).not.toHaveBeenCalled();
});
