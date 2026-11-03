import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createWalletRechargeOrder: vi.fn() }));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  ApiPaymentValidationError: class extends Error {},
  apiPaymentCheckoutService: { createWalletRechargeOrder: mocks.createWalletRechargeOrder },
}));

import { POST } from '../../src/api/routes/pay/recharges.ts';

describe('wallet recharge checkout route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWalletRechargeOrder.mockResolvedValue({
      order: { id: 'order-1', state: 'pending' }, checkoutToken: 'checkout-token',
    });
  });

  it('uses the authenticated user as the recharge target and ignores forged target fields', async () => {
    const response = await POST({
      request: new Request('https://app.example.test/api/pay/recharges', {
        method: 'POST', body: JSON.stringify({ amount: 2500, currency: 'EUR', paymentCountry: 'FR', targetUserId: 'other-user', merchantProfileId: 'merchant-1' }),
      }),
      locals: { user: { id: 'user-1' } },
    } as any);

    expect(response.status).toBe(201);
    expect(mocks.createWalletRechargeOrder).toHaveBeenCalledWith({ targetUserId: 'user-1', amount: 2500, currency: 'EUR', paymentCountry: 'FR' });
    expect(await response.json()).toEqual({
      id: 'order-1', status: 'pending', checkoutUrl: 'https://app.example.test/fr/pay/checkout/?token=checkout-token',
    });
  });

  it('rejects a recharge without a payment country before creating an order', async () => {
    const response = await POST({
      request: new Request('https://app.example.test/api/pay/recharges', {
        method: 'POST', body: JSON.stringify({ amount: 2500, currency: 'EUR' }),
      }),
      locals: { user: { id: 'user-1' } },
    } as any);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'amount must be a positive integer and currency must be a three-letter uppercase code and paymentCountry must be a valid country code' });
    expect(mocks.createWalletRechargeOrder).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const response = await POST({ request: new Request('https://app.example.test/api/pay/recharges', { method: 'POST', body: '{}' }), locals: {} } as any);
    expect(response.status).toBe(401);
    expect(mocks.createWalletRechargeOrder).not.toHaveBeenCalled();
  });
});
