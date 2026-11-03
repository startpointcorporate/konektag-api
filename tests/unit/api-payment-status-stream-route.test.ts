import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({
  getPublicOrder: vi.fn(),
}));

const redisMocks = vi.hoisted(() => ({
  subscribePaymentStatus: vi.fn(),
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
}));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({
  redisAdapter: redisMocks,
}));

import { GET } from '../../src/api/routes/pay/checkout/[token]/status-stream.ts';

function subscription(events: Array<Record<string, unknown>> = []) {
  let resolveNext: ((result: IteratorResult<Record<string, unknown>>) => void) | null = null;
  let stopped = false;
  const unsubscribe = vi.fn().mockImplementation(async () => {
    stopped = true;
    resolveNext?.({ value: undefined, done: true });
  });
  return {
    unsubscribe,
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
        if (events.length) return { value: events.shift()!, done: false };
        if (stopped) return { value: undefined, done: true };
        return new Promise((resolve) => { resolveNext = resolve; });
      },
    }),
  };
}

describe('API payment status stream route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates the checkout, streams only safe status fields, and disables proxy buffering', async () => {
    const activeSubscription = subscription();
    redisMocks.subscribePaymentStatus.mockResolvedValue(activeSubscription);
    checkoutMocks.getPublicOrder
      .mockResolvedValueOnce({
        id: 'order-1', state: 'pending', paymentMethod: null, paidAt: null,
        payerIdentity: 'payer@example.test', checkoutTokenHash: 'never-send-this',
      })
      .mockResolvedValueOnce({
        id: 'order-1', state: 'processing', paymentMethod: 'card', paidAt: null,
        payerIdentity: 'payer@example.test', signingSecret: 'never-send-this',
      });

    const response = await GET({ params: { token: 'checkout-token' } } as any);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(redisMocks.subscribePaymentStatus).toHaveBeenCalledWith('order-1');

    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toMatch(/^event: payment_status\ndata: /);
    const payload = JSON.parse(text.match(/data: (.*)\n\n/)![1]);
    expect(payload).toMatchObject({ state: 'processing', paymentMethod: 'card', paidAt: null });
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('payerIdentity');
    expect(payload).not.toHaveProperty('checkoutTokenHash');
    expect(payload).not.toHaveProperty('signingSecret');

    await reader.cancel();
    expect(activeSubscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('returns 404 without creating a Redis subscription for an invalid token', async () => {
    const { ApiPaymentNotFoundError } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
    checkoutMocks.getPublicOrder.mockRejectedValue(new ApiPaymentNotFoundError('Checkout not found'));

    const response = await GET({ params: { token: 'invalid-token' } } as any);

    expect(response.status).toBe(404);
    expect(redisMocks.subscribePaymentStatus).not.toHaveBeenCalled();
  });
});
