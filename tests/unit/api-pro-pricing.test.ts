import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveCountry: vi.fn(),
  resolvePricing: vi.fn(),
  supportsProvider: vi.fn(),
}));

vi.mock('../../src/application/services/pay/payment-country-resolver.ts', () => ({
  paymentCountryResolver: { resolve: mocks.resolveCountry },
}));

vi.mock('../../src/application/services/pay/pro-pricing-resolver.ts', async () => {
  class ProPricingResolutionError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = 'ProPricingResolutionError';
    }
  }
  return {
    ProPricingResolutionError,
    resolvePricing: mocks.resolvePricing,
  };
});

vi.mock('../../src/application/services/pay/pro-payment-provider.ts', () => ({
  supportsProPaymentProvider: mocks.supportsProvider,
}));

import { GET } from '../../src/api/routes/pro/pricing.ts';
import { ProPricingResolutionError } from '../../src/application/services/pay/pro-pricing-resolver.ts';

function makeUrl(countryCode: string) {
  const url = new URL('http://localhost:4321/api/pro/pricing');
  url.searchParams.set('country', countryCode);
  return url;
}

function pricing(period: 'MONTHLY' | 'ANNUAL', amountMinor: number, currency: string, country: string) {
  return {
    itemCode: period === 'MONTHLY' ? 'KTG-PRO-MONTHLY' : 'KTG-PRO-ANNUAL',
    period,
    amountMinor,
    currency,
    marketCountry: country,
    legalEntityId: `LE-${country}`,
    corridor: `CORRIDOR-${country}`,
    pricingSource: 'FRAPPE_EXPLICIT' as const,
  };
}

describe('GET /api/pro/pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supportsProvider.mockReturnValue(true);
  });

  it('returns final FR minor-unit amounts from the resolver without reconversion', async () => {
    mocks.resolveCountry.mockResolvedValue({ paymentCountry: 'FR' });
    mocks.resolvePricing
      .mockResolvedValueOnce(pricing('MONTHLY', 8900, 'EUR', 'FR'))
      .mockResolvedValueOnce(pricing('ANNUAL', 101400, 'EUR', 'FR'));

    const res = await GET({ url: makeUrl('FR') } as any);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.resolvePricing).toHaveBeenNthCalledWith(1, 'FR', 'MONTHLY');
    expect(mocks.resolvePricing).toHaveBeenNthCalledWith(2, 'FR', 'ANNUAL');
    expect(json.currency).toBe('EUR');
    expect(json.monthly.amountMinor).toBe(8900);
    expect(json.annual.amountMinor).toBe(101400);
    expect(json.pricingSource).toBe('FRAPPE_EXPLICIT');
  });

  it.each(['CG', 'CM', 'GA'])('returns final XAF amounts for %s without FX', async country => {
    mocks.resolveCountry.mockResolvedValue({ paymentCountry: country });
    mocks.resolvePricing
      .mockResolvedValueOnce(pricing('MONTHLY', 59000, 'XAF', country))
      .mockResolvedValueOnce(pricing('ANNUAL', 672600, 'XAF', country));

    const res = await GET({ url: makeUrl(country) } as any);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.currency).toBe('XAF');
    expect(json.monthly.amountMinor).toBe(59000);
    expect(json.annual.amountMinor).toBe(672600);
  });

  it('returns the resolver error code for a country without a Price List', async () => {
    mocks.resolveCountry.mockResolvedValue({ paymentCountry: 'US' });
    mocks.resolvePricing.mockRejectedValue(
      new ProPricingResolutionError('PRO_PRICING_PRICE_LIST_NOT_CONFIGURED'),
    );

    const res = await GET({ url: makeUrl('US') } as any);
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe('PRO_PRICING_PRICE_LIST_NOT_CONFIGURED');
  });

  it('rejects malformed country codes before resolving pricing', async () => {
    const res = await GET({ url: makeUrl('FRA') } as any);
    expect(res.status).toBe(400);
    expect(mocks.resolveCountry).not.toHaveBeenCalled();
    expect(mocks.resolvePricing).not.toHaveBeenCalled();
  });

  it('rejects inconsistent currencies returned for monthly and annual pricing', async () => {
    mocks.resolveCountry.mockResolvedValue({ paymentCountry: 'FR' });
    mocks.resolvePricing
      .mockResolvedValueOnce(pricing('MONTHLY', 8900, 'EUR', 'FR'))
      .mockResolvedValueOnce(pricing('ANNUAL', 672600, 'XAF', 'FR'));

    const res = await GET({ url: makeUrl('FR') } as any);
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe('PRO_PRICING_CURRENCY_MISMATCH');
  });
});
