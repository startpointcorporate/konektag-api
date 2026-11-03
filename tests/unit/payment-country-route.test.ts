import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../src/application/services/pay/payment-country-resolver.ts', () => ({
  PaymentCountryResolutionError: class extends Error { constructor(public code: string) { super(code); } },
  paymentCountryResolver: { resolve: mocks.resolve },
}));

import { GET } from '../../src/api/routes/pay/payment-country.ts';

describe('GET /api/pay/payment-country', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns BE payment country', async () => {
    mocks.resolve.mockResolvedValue({ detectedCountry: 'BE', paymentCountry: 'FR' });
    const response = await GET({ url: new URL('http://localhost/api/pay/payment-country?detectedCountry=BE') } as any);
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('BE');
    expect(await response.json()).toEqual({ detectedCountry: 'BE', paymentCountry: 'FR' });
  });

  it.each([
    ['PAYMENT_COUNTRY_INVALID', 400],
    ['PAYMENT_COUNTRY_MAPPING_NOT_FOUND', 404],
    ['PAYMENT_COUNTRY_MAPPING_AMBIGUOUS', 422],
  ])('maps %s to HTTP %i', async (code, status) => {
    const { PaymentCountryResolutionError } = await import('../../src/application/services/pay/payment-country-resolver.ts');
    mocks.resolve.mockRejectedValue(new PaymentCountryResolutionError(code));
    const response = await GET({ url: new URL('http://localhost/api/pay/payment-country?detectedCountry=BE') } as any);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});
