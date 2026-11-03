import { afterEach, describe, expect, it, vi } from 'vitest';
import { pawaPayClient } from '../../src/infrastructure/adapters/pawapay-client.ts';

describe('PawaPay Payment Page contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a fixed XAF payment page without MSISDN or operator selection', async () => {
    process.env.PAWAPAY_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.PAWAPAY_API_TOKEN = 'test-token';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'test-token';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://sandbox.paywith.pawapay.io/?token=session' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pawaPayClient.createPaymentPage({
      depositId: '00000000-0000-4000-8000-000000000001',
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/token/mobile-money/pawapay/return',
      amount: 7000,
      currency: 'XAF',
      country: 'CMR',
      reason: 'Konektag payment',
      metadata: [{ paymentOrderId: 'order-1' }],
      providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX',
    })).resolves.toBe('https://sandbox.paywith.pawapay.io/?token=session');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.pawapay.io/v2/paymentpage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      depositId: '00000000-0000-4000-8000-000000000001',
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/token/mobile-money/pawapay/return',
      amountDetails: { amount: '7000', currency: 'XAF' },
      country: 'CMR',
      reason: 'Konektag payment',
      metadata: [{ paymentOrderId: 'order-1' }],
    });
  });
});
