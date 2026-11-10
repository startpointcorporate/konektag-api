import { beforeEach, expect, it, vi } from 'vitest';

// Any query touching konektag.merchant_profiles fails the test: Link Pay no longer depends on it.
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query, connect: vi.fn() } }));
import { POST as create, GET as list } from '../../src/api/routes/pay/payment-links.ts';
import { POST as pay } from '../../src/api/routes/pay/pay-link.ts';
import { POST as catalogCheckout } from '../../src/api/routes/catalog/checkout.ts';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('merchant_profiles') || sql.includes('merchant_memberships')) throw new Error('MERCHANT_PROFILES_READ: ' + sql);
    return { rows: [] };
  });
});
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'payer@example.test' };
const retired = { error: 'LINK_PAY_MERCHANT_PROFILE_RETIRED' };

it('refuses to issue a link for a merchant profile (ERP user key, any body)', async () => {
  const response = await create({ locals: { user }, request: new Request('http://x', { method: 'POST', headers: { 'X-Idempotency-Key': 'a'.repeat(64) },
    body: JSON.stringify({ merchantProfileId: user.id, amount: '6500', currency: 'XAF' }) }) } as any);
  expect([response.status, await response.json()]).toEqual([410, retired]);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('refuses the merchant listing used by the user-key ERP channel', async () => {
  const response = await list({ locals: { user }, url: new URL('http://x/api/pay/payment-links?merchantProfileId=' + user.id + '&reference=INV') } as any);
  expect([response.status, await response.json()]).toEqual([410, retired]);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('refuses a catalogue checkout before quoting or creating a core transaction', async () => {
  const response = await catalogCheckout({ locals: { user }, request: new Request('http://x', { method: 'POST', body: '{}' }) } as any);
  expect([response.status, await response.json()]).toEqual([410, retired]);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('confirms only network links: an unknown or historical slug is not found, without reading merchant profiles', async () => {
  const response = await pay({ locals: { user }, request: new Request('http://x', { method: 'POST', body: JSON.stringify({ slug: 'legacy123' }) }) } as any);
  expect([response.status, await response.json()]).toEqual([404, { error: 'Lien introuvable, expire ou deja utilise' }]);
  for (const [sql] of mocks.query.mock.calls) expect(sql).not.toMatch(/merchant_profiles|merchant_memberships/);
  expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('link_pay_network_links'))).toBe(true);
});
