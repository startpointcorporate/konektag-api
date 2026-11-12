import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
}));

const checkoutMocks = vi.hoisted(() => ({
  getStripeOrder: vi.fn(),
  reservePointsKStripeInitiation: vi.fn(),
  attachStripePaymentIntent: vi.fn(),
  markFinalAndDispatch: vi.fn(),
}));

const providerAttemptMocks = vi.hoisted(() => ({
  createOrUpdateStripeApiCheckoutAttempt: vi.fn(),
  expireStaleApiPaymentAttempts: vi.fn(),
  hasActiveApiPaymentAttempt: vi.fn(),
  recordRechargeAccepted: vi.fn(),
}));

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
}));

vi.mock('stripe', () => ({
  default: class Stripe {
    paymentIntents = {
      create: stripeMocks.create,
      retrieve: stripeMocks.retrieve,
    };
  },
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentConflictError: class ApiPaymentConflictError extends Error {},
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
  ApiPaymentValidationError: class ApiPaymentValidationError extends Error {},
  toStripeAmount: (currency: string, amount: number) => currency === 'XOF' ? amount : amount * 100,
}));
vi.mock('../../src/application/services/pay/payment-provider-attempt-service.ts', () => ({
  paymentProviderAttemptService: providerAttemptMocks,
}));

import { POST as createIntent } from '../../src/api/routes/pay/checkout/[token]/stripe/create-intent.ts';
import { POST as finalize } from '../../src/api/routes/pay/checkout/[token]/stripe/finalize.ts';

const stripeOrder = {
  id: 'order-1',
  merchantTransactionId: 'merchant-tx-1',
  currency: 'XOF',
  totalAmount: 10_815,
  externalAmount: 3_815,
  providerExpectedAmount: 3_815,
  stripePaymentIntentId: null,
};

describe('API payment Stripe routes', () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalPublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const originalPublicKey = process.env.STRIPE_PUBLIC_KEY;

  beforeEach(() => {
    vi.resetAllMocks();
    checkoutMocks.getStripeOrder.mockResolvedValue(stripeOrder);
    checkoutMocks.reservePointsKStripeInitiation.mockImplementation(async () => new Date().toISOString());
    providerAttemptMocks.expireStaleApiPaymentAttempts.mockResolvedValue(0);
    providerAttemptMocks.hasActiveApiPaymentAttempt.mockResolvedValue(false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
    delete process.env.STRIPE_PUBLIC_KEY;
  });

  afterEach(() => {
    if (originalSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecretKey;
    if (originalPublishableKey === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = originalPublishableKey;
    if (originalPublicKey === undefined) delete process.env.STRIPE_PUBLIC_KEY;
    else process.env.STRIPE_PUBLIC_KEY = originalPublicKey;
  });

  it('retrieves the persisted Points K intent even when its local attempt expired', async () => {
    checkoutMocks.getStripeOrder.mockResolvedValue({ ...stripeOrder, pointsK: true, stripePaymentIntentId: 'pi_existing' });
    stripeMocks.retrieve.mockResolvedValue({ id: 'pi_existing', client_secret: 'secret', amount: 3815, currency: 'xof', status: 'processing',
      metadata: { konektag_source_type: 'api_payment', konektag_source_id: 'order-1', konektag_operation_id: 'order-1' } });
    const response = await createIntent({ params: { token: 'checkout-token' }, locals: {} } as any);
    expect(response.status).toBe(201);
    expect(stripeMocks.create).not.toHaveBeenCalled();
    expect(stripeMocks.retrieve).toHaveBeenCalledWith('pi_existing');
    expect(await response.json()).toMatchObject({ status: 'processing', paymentIntentId: 'pi_existing' });
  });

  it('uses the same Points K creation key after a lost Stripe response', async () => {
    checkoutMocks.getStripeOrder.mockResolvedValue({ ...stripeOrder, pointsK: true });
    stripeMocks.create.mockRejectedValue(new Error('response lost'));
    for (let n = 0; n < 2; n++) await createIntent({ params: { token: 'checkout-token' }, locals: {} } as any);
    expect(stripeMocks.create.mock.calls.map(call => call[1].idempotencyKey)).toEqual([
      'api-payment-order:order-1:points-k', 'api-payment-order:order-1:points-k',
    ]);
  });

  it('keeps an old unreferenced initiation unresolved instead of creating another operation', async () => {
    checkoutMocks.getStripeOrder.mockResolvedValue({ ...stripeOrder, pointsK: true });
    checkoutMocks.reservePointsKStripeInitiation.mockResolvedValue('2000-01-01T00:00:00Z');
    expect((await createIntent({ params: { token: 'checkout-token' }, locals: {} } as any)).status).toBe(409);
    expect(stripeMocks.create).not.toHaveBeenCalled();
  });

  it.each([1_200, 8_900, 101_460])('sends an exact EUR minor amount of %i to Stripe', async amountMinor => {
    const order = { ...stripeOrder, currency: 'EUR', totalAmount: amountMinor, externalAmount: amountMinor,
      providerExpectedAmount: amountMinor, amountUnit: 'MINOR' };
    checkoutMocks.getStripeOrder.mockResolvedValue(order);
    checkoutMocks.attachStripePaymentIntent.mockResolvedValue({ ...order, stripePaymentIntentId: 'pi_pro' });
    stripeMocks.create.mockResolvedValue({ id: 'pi_pro', client_secret: 'secret', amount: amountMinor, currency: 'eur',
      metadata: { konektag_source_type: 'api_payment', konektag_source_id: 'order-1', konektag_operation_id: 'order-1' } });
    const response = await createIntent({ params: { token: 'checkout-token' }, locals: { user: { id: 'user-1' } } } as any);
    expect(response.status).toBe(201);
    expect(stripeMocks.create).toHaveBeenCalledWith(expect.objectContaining({ amount: amountMinor, currency: 'eur' }),
      { idempotencyKey: 'api-payment-order:order-1:attempt:11111111-1111-4111-8111-111111111111' });
  });

  it('creates an intent from the stored external XOF amount and passes the authenticated payer', async () => {
    checkoutMocks.getStripeOrder.mockResolvedValue(stripeOrder);
    checkoutMocks.reservePointsKStripeInitiation.mockImplementation(async () => new Date().toISOString());
    checkoutMocks.attachStripePaymentIntent.mockResolvedValue({ ...stripeOrder, stripePaymentIntentId: 'pi_stored' });
    stripeMocks.create.mockResolvedValue({
      id: 'pi_stored',
      client_secret: 'pi_stored_secret',
      amount: 3_815,
      currency: 'xof',
      metadata: {
        konektag_source_type: 'api_payment',
        konektag_source_id: 'order-1',
        konektag_operation_id: 'order-1',
      },
    });

    const locals = { user: { id: 'user-1', keycloak_id: 'keycloak-1', username: 'payer', email: 'payer@example.test' } };
    const response = await createIntent({ params: { token: 'checkout-token' }, locals } as any);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      clientSecret: 'pi_stored_secret',
      publishableKey: 'pk_test_example',
      paymentIntentId: 'pi_stored',
    });
    expect(stripeMocks.create).toHaveBeenCalledWith({
      amount: 3_815,
      currency: 'xof',
      payment_method_types: ['card'],
      metadata: {
        konektag_source_type: 'api_payment',
        konektag_source_id: 'order-1',
        konektag_operation_id: 'order-1',
      },
    }, { idempotencyKey: 'api-payment-order:order-1:attempt:11111111-1111-4111-8111-111111111111' });
    expect(checkoutMocks.getStripeOrder).toHaveBeenCalledWith('checkout-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer', email: 'payer@example.test',
    });
    expect(providerAttemptMocks.expireStaleApiPaymentAttempts).toHaveBeenCalledWith('order-1');
    expect(checkoutMocks.attachStripePaymentIntent).toHaveBeenCalledWith('checkout-token', 'pi_stored');
    expect(providerAttemptMocks.createOrUpdateStripeApiCheckoutAttempt).toHaveBeenCalledWith({
      orderId: 'order-1',
      metadata: undefined,
      paymentIntent: expect.objectContaining({ id: 'pi_stored' }),
    });
  });

  it('returns the stored PaymentIntent status without allowing the browser to settle it', async () => {
    const storedOrder = { ...stripeOrder, stripePaymentIntentId: 'pi_stored' };
    checkoutMocks.getStripeOrder.mockResolvedValue(storedOrder);
    stripeMocks.retrieve.mockResolvedValue({
      id: 'pi_stored',
      status: 'succeeded',
      amount: 3_815,
      currency: 'xof',
      metadata: {
        konektag_source_type: 'api_payment',
        konektag_source_id: 'order-1',
        konektag_operation_id: 'order-1',
      },
    });

    const response = await finalize({
      params: { token: 'checkout-token' },
      locals: { user: { id: 'user-1', keycloak_id: 'keycloak-1', username: 'payer' } },
      request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ paymentIntentId: 'pi_attacker' }) }),
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'succeeded',
      settlement: 'awaiting_webhook',
      message: 'Payment settlement awaits the Stripe webhook.',
    });
    expect(stripeMocks.retrieve).toHaveBeenCalledWith('pi_stored');
    expect(checkoutMocks.markFinalAndDispatch).not.toHaveBeenCalled();
  });

  it('returns a configuration error when the publishable key is missing', async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const response = await createIntent({ params: { token: 'checkout-token' } } as any);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Stripe is not configured: STRIPE_PUBLISHABLE_KEY is required' });
    expect(stripeMocks.create).not.toHaveBeenCalled();
  });
});
