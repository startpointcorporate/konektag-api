import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));
import { validateRestaurantRouting, validateRouting, validateStoredRestaurantCollector } from '../../src/application/link-pay/frappe-site-routing.ts';
import { enqueueSiteWebhooks } from '../../src/application/link-pay/site-webhook-service.ts';
const config = { tokenSha256: 'a'.repeat(64), webhookSecret: 'test-secret-'.repeat(4), restaurantCollectors: { Restaurant: 'CONGO' } };
const site = { key: 'RESTODEMO', config };
const env = { LINK_PAY_FRAPPE_SITES: JSON.stringify({ RESTODEMO: config, CONGO: { tokenSha256: 'b'.repeat(64), network: true } }),
  MARKETPLACE_FRAPPE_RESTODEMO_URL: 'https://restodemo.example.test' };
afterEach(() => vi.unstubAllEnvs());
it('permits only the exact execution site/POS collector entitlement; invoices retain their identity', () => {
  expect(validateRestaurantRouting(site, 'Restaurant', 'CONGO', 'CONGO', env)).toEqual({ beneficiarySite: 'CONGO', networkSite: 'CONGO' });
  expect(() => validateRestaurantRouting(site, 'Other', 'CONGO', 'CONGO', env)).toThrow('RESTAURANT_COLLECTOR_NOT_ALLOWED');
  expect(() => validateRestaurantRouting(site, 'Restaurant', 'OTHER', 'CONGO', env)).toThrow('BENEFICIARY_SITE_MISMATCH');
  expect(() => validateRouting(site, 'CONGO', 'CONGO', env)).toThrow('BENEFICIARY_SITE_MISMATCH');
});
it('revalidates the explicit collector entitlement before debit', () => {
  vi.stubEnv('LINK_PAY_FRAPPE_SITES', env.LINK_PAY_FRAPPE_SITES);
  expect(() => validateStoredRestaurantCollector('RESTODEMO', 'Restaurant', 'CONGO')).not.toThrow();
  expect(() => validateStoredRestaurantCollector('RESTODEMO', 'Other', 'CONGO')).toThrow('RESTAURANT_COLLECTOR_NOT_ALLOWED');
});
it('sends the restaurant proof to its execution site while preserving the existing collector in the ledger payload', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: 'delivery' }] });
  await enqueueSiteWebhooks({ query } as any, { slug: 'link1', transaction: {
    id: 'transaction', k_operation_id: 'operation', paid_at: '2026-11-15T10:00:00Z', currency: 'XAF', quantity_k: 100,
    gross_minor: 100, fee_minor: 0, net_minor: 100,
  }, link: { issuer_site: 'RESTODEMO', beneficiary_site: 'CONGO', network_site: 'CONGO', invoice: 'ORD1',
    invoice_company: 'Local Company', collection_source_type: 'restaurant_order',
    collection_source: { attempt: 'attempt', posProfile: 'Restaurant', fingerprint: 'a'.repeat(64), collectorSite: 'CONGO' }, fee_rate_bps: 0 } });
  const args = query.mock.calls[0][1]; expect(args[1]).toBe('RESTODEMO');
  expect(JSON.parse(args[5])).toMatchObject({ issuerSite: 'RESTODEMO', beneficiarySite: 'CONGO', networkSite: 'CONGO',
    sourceClaim: 'link1', sourceAttempt: 'attempt', grossAmount: 100, feeAmount: 0 });
});
