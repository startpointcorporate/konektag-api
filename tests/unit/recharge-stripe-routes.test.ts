import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeMocks = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn() }));
const rechargeMocks = vi.hoisted(() => ({ createRecharge: vi.fn() }));
const attemptMocks = vi.hoisted(() => ({ createStripeRechargeAttempt: vi.fn() }));
const genericRechargeMocks = vi.hoisted(() => ({ createRecharge: vi.fn() }));

vi.mock('stripe', () => ({
  default: class Stripe {
    paymentIntents = { create: stripeMocks.create, retrieve: stripeMocks.retrieve };
  },
}));
vi.mock('../../src/application/shared/auth-helper.ts', () => ({ getAuthPayload: vi.fn().mockResolvedValue({ sub: 'kc-1', email: 'payer@example.test' }) }));
vi.mock('../../src/application/services/recharge-service.ts', () => ({ rechargeService: rechargeMocks }));
vi.mock('../../src/application/services/pay/payment-provider-attempt-service.ts', () => ({ paymentProviderAttemptService: attemptMocks }));

import { POST as createIntent } from '../../src/api/routes/recharge/stripe/create-intent.ts';
import { POST as browserConfirm } from '../../src/api/routes/recharge/stripe/confirm.ts';
import { POST as genericRecharge } from '../../src/api/routes/recharge.ts';

describe('Stripe recharge routes', () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
  });

  it('creates a pending recharge source and a minimized Stripe intent attempt', async () => {
    rechargeMocks.createRecharge.mockResolvedValue({ doc: { name: 'REC-1' } });
    stripeMocks.create.mockResolvedValue({ id: 'pi_1', client_secret: 'secret', amount: 2500, currency: 'eur', status: 'requires_payment_method' });
    const response = await createIntent({
      request: new Request('http://localhost/api/recharge/stripe/create-intent', { method: 'POST', body: JSON.stringify({ amount: 2500, currency: 'EUR', country: 'FR' }) }),
      cookies: {}, url: new URL('http://localhost'),
    } as any);

    expect(response.status).toBe(201);
    expect(rechargeMocks.createRecharge).toHaveBeenCalledWith(expect.objectContaining({ amount: 25, paymentMethod: 'Stripe', status: 'Pending' }));
    expect(stripeMocks.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: {
      konektag_source_type: 'recharge', konektag_source_id: 'REC-1', konektag_operation_id: 'REC-1',
    } }), { idempotencyKey: 'recharge:REC-1' });
    expect(JSON.stringify(stripeMocks.create.mock.calls[0][0].metadata)).not.toContain('payer@example.test');
    expect(attemptMocks.createStripeRechargeAttempt).toHaveBeenCalledWith({ rechargeName: 'REC-1', paymentIntent: expect.objectContaining({ id: 'pi_1' }) });
  });

  it('browser confirmation only reports a checked status and cannot credit a recharge', async () => {
    stripeMocks.retrieve.mockResolvedValue({ id: 'pi_1', status: 'succeeded', metadata: {
      konektag_source_type: 'recharge', konektag_source_id: 'REC-1', konektag_operation_id: 'REC-1',
    } });
    const response = await browserConfirm({
      request: new Request('http://localhost/api/recharge/stripe/confirm', { method: 'POST', body: JSON.stringify({ paymentIntentId: 'pi_1' }) }),
      cookies: {}, url: new URL('http://localhost'),
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'succeeded', settlement: 'awaiting_webhook' });
    expect(rechargeMocks.createRecharge).not.toHaveBeenCalled();
  });

  it.each(['Stripe', 'Google Pay', 'Apple Pay'])('rejects direct %s generic recharge credits', async (paymentMethod) => {
    const response = await genericRecharge({
      request: new Request('http://localhost/api/recharge', { method: 'POST', body: JSON.stringify({ amount: 100, currency: 'EUR', paymentMethod, country: 'FR' }) }),
      cookies: { get: () => ({ value: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJrYy0xIn0.' }) },
    } as any);

    expect(response.status).toBe(400);
    expect(rechargeMocks.createRecharge).not.toHaveBeenCalled();
  });
});
