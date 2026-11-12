import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({
  getMobileMoneyOrder: vi.fn(),
  confirmCheckout: vi.fn(),
}));

const attemptMocks = vi.hoisted(() => ({
  createOrGetPawaPayApiCheckoutAttempt: vi.fn(),
  getPawaPayConfigurationKey: vi.fn(),
  recordRechargeAccepted: vi.fn(),
}));

const pawaPayClientMocks = vi.hoisted(() => ({
  createPaymentPage: vi.fn(),
  getDeposit: vi.fn(),
}));

const depositServiceMocks = vi.hoisted(() => ({
  consume: vi.fn(),
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentConflictError: class ApiPaymentConflictError extends Error {},
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
  ApiPaymentValidationError: class ApiPaymentValidationError extends Error {},
}));

vi.mock('../../src/application/services/pay/payment-provider-attempt-service.ts', () => ({
  paymentProviderAttemptService: attemptMocks,
}));

vi.mock('../../src/infrastructure/adapters/pawapay-client.ts', () => ({
  pawaPayClient: pawaPayClientMocks,
  PawaPayError: class PawaPayError extends Error {},
}));

vi.mock('../../src/application/services/pay/pawapay-deposit-service.ts', () => ({
  pawaPayDepositService: depositServiceMocks,
}));

vi.mock('../../src/application/shared/public-origin.ts', () => ({
  getPublicOrigin: vi.fn(() => 'https://www.konektag.eu'),
}));

import { POST as depositPost } from '../../src/api/routes/pay/checkout/[token]/mobile-money/pawapay/deposit.ts';
import { GET as returnGet } from '../../src/api/routes/pay/checkout/[token]/mobile-money/pawapay/return.ts';

describe('PawaPay locale propagation routes', () => {
  it('rejects a sandbox Payment Page before attempts or checkout mutation on the shared API', async () => {
    checkoutMocks.getMobileMoneyOrder.mockResolvedValue({ id: 'order-1', providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX' });
    const response = await depositPost({ params: { token: 'token' }, locals: {},
      request: new Request('https://api.konektag.eu/x', { method: 'POST', body: '{}' }) } as any);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'PAWAPAY_SANDBOX_DISABLED' });
    expect(attemptMocks.createOrGetPawaPayApiCheckoutAttempt).not.toHaveBeenCalled();
    expect(checkoutMocks.confirmCheckout).not.toHaveBeenCalled();
    expect(pawaPayClientMocks.createPaymentPage).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    checkoutMocks.getMobileMoneyOrder.mockResolvedValue({
      id: 'order-1',
      currency: 'XAF',
      externalAmount: 12_500,
      paymentCountry: 'COG',
      providerConfigurationKey: 'KTG_CG_PAWAPAY_LIVE',
    });
    checkoutMocks.confirmCheckout.mockResolvedValue({ order: { state: 'awaiting_mobile_money' } });
    attemptMocks.createOrGetPawaPayApiCheckoutAttempt.mockResolvedValue('dep-123');
    pawaPayClientMocks.createPaymentPage.mockResolvedValue('https://pay.pawapay.io/redirect/dep-123');
    attemptMocks.getPawaPayConfigurationKey.mockResolvedValue('KTG_CG_PAWAPAY_LIVE');
    pawaPayClientMocks.getDeposit.mockResolvedValue({ depositId: 'dep-123', status: 'COMPLETED', amount: '12500', currency: 'XAF' });
    depositServiceMocks.consume.mockResolvedValue(undefined);
  });

  it('uses explicit lang from request body when creating provider returnUrl', async () => {
    const response = await depositPost({
      params: { token: 'checkout-token' },
      locals: {},
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: 'en' }),
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ redirectUrl: 'https://pay.pawapay.io/redirect/dep-123', state: 'awaiting_mobile_money' });
    expect(pawaPayClientMocks.createPaymentPage).toHaveBeenCalledWith(expect.objectContaining({
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=en',
      amount: 12_500,
    }));
  });

  it('sends the exact zero-decimal XAF amount to pawaPay', async () => {
    checkoutMocks.getMobileMoneyOrder.mockResolvedValue({
      id: 'order-1', currency: 'XAF', externalAmount: 8_567, paymentCountry: 'COG',
      providerConfigurationKey: 'KTG_CG_PAWAPAY_LIVE',
    });
    const response = await depositPost({
      params: { token: 'checkout-token' }, locals: {},
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/deposit', { method: 'POST' }),
    } as any);
    expect(response.status).toBe(201);
    expect(attemptMocks.createOrGetPawaPayApiCheckoutAttempt).toHaveBeenCalledWith(expect.objectContaining({ amount: 8_567, currency: 'XAF' }));
    expect(pawaPayClientMocks.createPaymentPage).toHaveBeenCalledWith(expect.objectContaining({ amount: 8_567, currency: 'XAF' }));
  });

  it('falls back to locale from referer path when body lang is absent', async () => {
    const response = await depositPost({
      params: { token: 'checkout-token' },
      locals: {},
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/deposit', {
        method: 'POST',
        headers: { referer: 'https://www.konektag.eu/pt/pay/checkout?token=checkout-token' },
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(pawaPayClientMocks.createPaymentPage).toHaveBeenCalledWith(expect.objectContaining({
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=pt',
    }));
  });

  it('defaults to fr when lang and referer locale are unavailable', async () => {
    const response = await depositPost({
      params: { token: 'checkout-token' },
      locals: {},
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/deposit', {
        method: 'POST',
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(pawaPayClientMocks.createPaymentPage).toHaveBeenCalledWith(expect.objectContaining({
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=fr',
    }));
  });

  it('redirects provider return to pending page using requested locale', async () => {
    const response = await returnGet({
      params: { token: 'checkout-token' },
      url: new URL('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=es'),
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=es'),
    } as any);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://www.konektag.eu/es/pay/checkout/pending?token=checkout-token');
  });

  it('keeps redirecting even when fetching deposit details fails', async () => {
    pawaPayClientMocks.getDeposit.mockRejectedValue(new Error('provider timeout'));

    const response = await returnGet({
      params: { token: 'checkout-token' },
      url: new URL('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=xx&depositId=dep-123'),
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/mobile-money/pawapay/return?lang=xx&depositId=dep-123'),
    } as any);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://www.konektag.eu/fr/pay/checkout/pending?token=checkout-token');
    expect(depositServiceMocks.consume).not.toHaveBeenCalled();
  });
});
