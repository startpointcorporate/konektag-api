import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentContextResolutionError } from '../../src/application/services/pay/payment-context-resolver.ts';
const calls = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock('../../src/application/services/pay/points-k-checkout-service.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/application/services/pay/points-k-checkout-service.ts')>(),
  readPointsKCheckout: calls.read, createPointsKCheckout: calls.create,
}));
import { GET, POST } from '../../src/api/routes/points-k/checkout.ts';
const refs = { country: 'FR', customer: 'TEST', quotation: 'QTN' };
const locals = { user: { id: 'u', keycloak_id: 'kc' } };
beforeEach(() => vi.resetAllMocks());
describe('Points K checkout context failures', () => {
  for (const method of ['GET', 'POST'] as const) {
    it(`${method} returns the missing production regulatory profile code`, async () => {
      calls.read.mockRejectedValue(new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND'));
      calls.create.mockRejectedValue(new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND'));
      const result = method === 'GET'
        ? await GET({ url: new URL('https://test.invalid/?' + new URLSearchParams(refs)), locals } as any)
        : await POST({ request: new Request('https://test.invalid/', { method: 'POST', body: JSON.stringify({ ...refs, modeOfPayment: 'Cash' }) }), locals } as any);
      expect(result.status).toBe(422);
      expect(await result.json()).toEqual({ error: 'PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND' });
      expect(result.headers.get('cache-control')).toBe('no-store');
    });
  }
});
