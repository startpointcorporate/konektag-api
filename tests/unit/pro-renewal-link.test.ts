import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), detect: vi.fn(), map: vi.fn(), context: vi.fn(),
  rate: vi.fn(), createOrder: vi.fn(),
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {
  query: mocks.query, connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
} }));
vi.mock('../../src/application/services/pay/detected-country-service.ts', () => ({ detectCountry: mocks.detect }));
vi.mock('../../src/application/services/pay/payment-country-resolver.ts', () => ({
  paymentCountryResolver: { resolve: mocks.map },
}));
vi.mock('../../src/application/services/pay/payment-context-resolver.ts', () => ({
  paymentContextResolver: { resolve: mocks.context },
}));
vi.mock('../../src/application/services/exchange-rate-service.ts', () => ({
  exchangeRateService: { getRateEvidence: mocks.rate },
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: { createOrder: mocks.createOrder },
}));

import { GET } from '../../src/api/routes/merchant/pro-renewal-links/[id].ts';

describe('Pro renewal payment link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{
      merchant_profile_id: 'merchant', subscription_type: 'MONTHLY', merchant_country: 'FR',
      status: 'PENDING', payment_order_id: null, checkout_attempts: 0, created_at: new Date(),
    }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    mocks.query.mockImplementation(async (sql: string) => String(sql).includes('SELECT mp.id FROM konektag.merchant_profiles')
      ? { rows: [{ id: 'network-merchant' }] } : { rowCount: 1 });
    mocks.createOrder.mockResolvedValue({ order: { id: 'order' }, checkoutToken: 'secret' });
  });

  it.each([
    ['FR', 'EUR', null, 8900],
    ['CG', 'XAF', { id: 'rate', rate: '655.957', inverse: false, source: 'ECB', valuedAt: '2026-09-17T00:00:00Z' }, 58380],
  ])('creates the %s corridor order only after the link is opened', async (detected, currency, rate, amountMinor) => {
    mocks.detect.mockResolvedValue(detected);
    mocks.map.mockResolvedValue({ paymentCountry: detected });
    mocks.context.mockResolvedValue({ currency, legalEntity: { code: currency === 'XAF' ? 'KTG-CG' : 'KTG-FR' }, providers: [currency === 'XAF'
      ? { provider: 'pawapay', paymentMethod: 'mobile_money' }
      : { provider: 'stripe', paymentMethod: 'card' }] });
    mocks.rate.mockResolvedValue(rate);
    const response = await GET({ params: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      request: new Request('https://example.test/link'), url: new URL('https://example.test/link') } as any);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/fr/pay/checkout/?token=secret');
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      merchantProfileId: 'network-merchant', currency, subtotalAmount: amountMinor, amountUnit: 'MINOR',
      metadata: expect.objectContaining({ paymentCountry: detected }),
    }));
  });

  it('does not create an order for a Frappe provider unsupported by its Checkout route', async () => {
    mocks.detect.mockResolvedValue('CD');
    mocks.map.mockResolvedValue({ paymentCountry: 'CD' });
    mocks.context.mockResolvedValue({ currency: 'CDF', legalEntity: { code: 'KTG-CD' }, providers: [{ provider: 'pawapay', paymentMethod: 'mobile_money' }] });
    const response = await GET({ params: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      request: new Request('https://example.test/link'), url: new URL('https://example.test/link') } as any);
    expect(response.status).toBe(503);
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('requires the network merchant of the selected legal entity', async () => {
    mocks.detect.mockResolvedValue('CG');
    mocks.map.mockResolvedValue({ paymentCountry: 'CG' });
    mocks.context.mockResolvedValue({ currency: 'XAF', legalEntity: { code: 'KTG-CG' },
      providers: [{ provider: 'pawapay', paymentMethod: 'mobile_money' }] });
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await GET({ params: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      request: new Request('https://example.test/link'), url: new URL('https://example.test/link') } as any);
    expect(response.status).toBe(503);
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
});
