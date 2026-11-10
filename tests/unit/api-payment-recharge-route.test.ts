import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createWalletRechargeOrder: vi.fn(), routePointsKPurchase: vi.fn() }));
vi.mock('../../src/application/services/pay/points-k-purchase-routing.ts', () => ({
  PointsKPurchaseRoutingError: class extends Error {},
  routePointsKPurchase: mocks.routePointsKPurchase,
}));
vi.mock('../../src/application/services/pay/payment-context-resolver.ts', () => ({
  PaymentContextResolutionError: class extends Error {},
  paymentContextErrorStatus: () => 422,
  publicPaymentContext: (context: unknown) => context,
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  ApiPaymentValidationError: class extends Error {},
  apiPaymentCheckoutService: { createWalletRechargeOrder: mocks.createWalletRechargeOrder },
}));

import { POST } from '../../src/api/routes/pay/recharges.ts';

describe('wallet recharge checkout route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routePointsKPurchase.mockResolvedValue({
      route: { residenceCountry: 'BE', paymentCountry: 'FR', slug: 'konektag-fr', site: 'EUROPE', timezone: 'Europe/Paris' },
      context: { country: 'FR', currency: 'EUR', konektagSite: 'konektag-fr', providers: [] },
    });
    mocks.createWalletRechargeOrder.mockResolvedValue({
      order: { id: 'order-1', state: 'pending' }, checkoutToken: 'checkout-token',
    });
  });

  it('uses the authenticated user as the recharge target and ignores forged target fields', async () => {
    const response = await POST({
      request: new Request('https://app.example.test/api/pay/recharges', {
        method: 'POST', body: JSON.stringify({ amount: 2500, currency: 'EUR', paymentCountry: 'CG', targetUserId: 'other-user', merchantProfileId: 'merchant-1' }),
      }),
      locals: { user: { id: 'user-1' } },
    } as any);

    expect(response.status).toBe(201);
    // The payment country comes from the buyer's routed site, never from the body.
    expect(mocks.routePointsKPurchase).toHaveBeenCalledWith('user-1');
    expect(mocks.createWalletRechargeOrder).toHaveBeenCalledWith({ targetUserId: 'user-1', amount: 2500, currency: 'EUR', paymentCountry: 'FR', konektagSite: { slug: 'konektag-fr' } });
    expect(await response.json()).toEqual({
      id: 'order-1', status: 'pending', checkoutUrl: 'https://app.example.test/fr/pay/checkout/?token=checkout-token',
      konektagSite: 'konektag-fr', paymentContext: { country: 'FR', currency: 'EUR', konektagSite: 'konektag-fr', providers: [] },
    });
  });

  it('rejects an invalid amount before routing or creating an order', async () => {
    const response = await POST({
      request: new Request('https://app.example.test/api/pay/recharges', {
        method: 'POST', body: JSON.stringify({ amount: -1, currency: 'EUR' }),
      }),
      locals: { user: { id: 'user-1' } },
    } as any);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'amount must be a positive integer and currency must be a three-letter uppercase code' });
    expect(mocks.routePointsKPurchase).not.toHaveBeenCalled();
    expect(mocks.createWalletRechargeOrder).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const response = await POST({ request: new Request('https://app.example.test/api/pay/recharges', { method: 'POST', body: '{}' }), locals: {} } as any);
    expect(response.status).toBe(401);
    expect(mocks.createWalletRechargeOrder).not.toHaveBeenCalled();
  });
});
