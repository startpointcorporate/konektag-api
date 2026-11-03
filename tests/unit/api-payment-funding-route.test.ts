import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({
  prepareSelectedFunding: vi.fn(),
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentConflictError: class ApiPaymentConflictError extends Error {},
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
  ApiPaymentValidationError: class ApiPaymentValidationError extends Error {},
}));

import { POST } from '../../src/api/routes/pay/checkout/[token]/funding.ts';

describe('API payment funding route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prepares funding from a Payment Context selection without calling the fee route', async () => {
    checkoutMocks.prepareSelectedFunding.mockResolvedValue({
      feeAmount: 315,
      totalAmount: 10_815,
      walletAvailable: 7_000,
      walletAmount: 7_000,
      externalAmount: 3_815,
      allowedPaymentMethods: ['card', 'mobile_money'],
    });

    const response = await POST({
      params: { token: 'checkout-token' },
      locals: { user: { id: 'user-1', keycloak_id: 'keycloak-1', username: 'payer', email: 'payer@example.test' } },
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ selectionToken: 'signed-selection' }) }),
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      feeAmount: 315,
      totalAmount: 10_815,
      walletAvailable: 7_000,
      walletAmount: 7_000,
      externalAmount: 3_815,
      allowedPaymentMethods: ['card', 'mobile_money'],
    });
    expect(checkoutMocks.prepareSelectedFunding).toHaveBeenCalledWith('checkout-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer', email: 'payer@example.test',
    }, 'signed-selection', {});
  });

  it('rejects a frontend selection that is not issued by Payment Context', async () => {
    const response = await POST({
      params: { token: 'checkout-token' }, locals: {},
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ provider: 'stripe', providerConfigurationKey: 'KTG_FR_STRIPE_TEST' }) }),
    } as any);

    expect(response.status).toBe(400);
    expect(checkoutMocks.prepareSelectedFunding).not.toHaveBeenCalled();
  });
});
