import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({
  cancelCheckout: vi.fn(),
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentConflictError: class ApiPaymentConflictError extends Error {},
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
  ApiPaymentValidationError: class ApiPaymentValidationError extends Error {},
}));

import { POST } from '../../src/api/routes/pay/checkout/[token]/cancel.ts';

describe('API checkout cancel route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects cross-origin cancellation requests', async () => {
    const response = await POST({
      params: { token: 'checkout-token' },
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/cancel', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example.test',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    } as any);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'CSRF_REJECTED' });
    expect(checkoutMocks.cancelCheckout).not.toHaveBeenCalled();
  });

  it('cancels an active checkout and returns the updated public order', async () => {
    checkoutMocks.cancelCheckout.mockResolvedValue({
      id: 'order-1',
      environment: 'live',
      merchantTransactionId: 'TX-1001',
      label: 'Payment request',
      currency: 'XAF',
      subtotalAmount: 10_000,
      taxAmount: 0,
      feeAmount: 300,
      cashbackAmount: 0,
      totalAmount: 10_300,
      state: 'cancelled',
      paymentMethod: 'mobile_money',
      paidAt: null,
      merchant: { name: 'Merchant', logoUrl: null },
    });

    const response = await POST({
      params: { token: 'checkout-token' },
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/cancel', {
        method: 'POST',
        headers: {
          Origin: 'https://www.konektag.eu',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      id: 'order-1',
      state: 'cancelled',
      merchantTransactionId: 'TX-1001',
    }));
    expect(checkoutMocks.cancelCheckout).toHaveBeenCalledWith('checkout-token');
  });

  it('returns 409 when cancellation is no longer allowed', async () => {
    const { ApiPaymentConflictError } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
    checkoutMocks.cancelCheckout.mockRejectedValue(new ApiPaymentConflictError('Paid checkouts cannot be cancelled'));

    const response = await POST({
      params: { token: 'checkout-token' },
      request: new Request('https://www.konektag.eu/api/pay/checkout/checkout-token/cancel', {
        method: 'POST',
        headers: { Origin: 'https://www.konektag.eu', 'Content-Type': 'application/json' },
        body: '{}',
      }),
    } as any);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Paid checkouts cannot be cancelled' });
  });
});
