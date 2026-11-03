import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeMocks = vi.hoisted(() => ({ constructEvent: vi.fn() }));
const providerMocks = vi.hoisted(() => ({
  consumeStripeEvent: vi.fn(),
  markStripeEventProcessed: vi.fn(),
}));
const checkoutMocks = vi.hoisted(() => ({ markFinalAndDispatch: vi.fn() }));
const rechargeMocks = vi.hoisted(() => ({ confirmStripeRecharge: vi.fn() }));

vi.mock('stripe', () => ({
  default: class Stripe {
    webhooks = { constructEvent: stripeMocks.constructEvent };
  },
}));
vi.mock('../../src/application/services/pay/payment-provider-attempt-service', () => ({
  paymentProviderAttemptService: providerMocks,
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service', () => ({
  apiPaymentCheckoutService: checkoutMocks,
}));

import { POST } from '../../src/api/routes/webhooks/stripe';

describe('Stripe webhook route', () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecretKey;
    if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  });

  function request() {
    return new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=signature' },
      body: '{"id":"evt_1"}',
    });
  }

  it('rejects a Stripe event with an invalid signature', async () => {
    stripeMocks.constructEvent.mockImplementation(() => { throw new Error('bad signature'); });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(400);
    expect(providerMocks.consumeStripeEvent).not.toHaveBeenCalled();
  });

  it('deduplicates a previously received event without settling again', async () => {
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'deduplicated' });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(200);
    expect(checkoutMocks.markFinalAndDispatch).not.toHaveBeenCalled();
  });

  it('does not settle a metadata-mismatched provider event', async () => {
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: {} } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'rejected' });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(200);
    expect(checkoutMocks.markFinalAndDispatch).not.toHaveBeenCalled();
    expect(rechargeMocks.confirmStripeRecharge).not.toHaveBeenCalled();
  });

  it('settles a verified API-card event and marks it processed', async () => {
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_3', type: 'payment_intent.succeeded', data: { object: { id: 'pi_card' } } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'ready_to_settle', eventId: 'event-row-1', sourceType: 'api_payment', sourceId: 'order-1' });
    checkoutMocks.markFinalAndDispatch.mockResolvedValue({ id: 'order-1', state: 'paid' });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(200);
    expect(checkoutMocks.markFinalAndDispatch).toHaveBeenCalledWith('order-1', 'card', 'pi_card', 'event-row-1');
    expect(providerMocks.markStripeEventProcessed).toHaveBeenCalledWith('event-row-1');
  });

  it('logs the verified event identity without exposing finalization errors to Stripe', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_4', type: 'payment_intent.succeeded', data: { object: { id: 'pi_failed' } } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'ready_to_settle', eventId: 'event-row-2', sourceType: 'api_payment', sourceId: 'order-2' });
    checkoutMocks.markFinalAndDispatch.mockRejectedValue(new Error('Merchant party must resolve unambiguously'));

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(500);
    expect(providerMocks.markStripeEventProcessed).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'Unable to process Stripe webhook' });
    expect(log).toHaveBeenCalledWith('[stripe-webhook] Unable to process verified event', {
      eventId: 'evt_4',
      eventType: 'payment_intent.succeeded',
      error: 'Merchant party must resolve unambiguously',
    });
  });

  it('refuses a retired legacy recharge without crediting it or marking its event processed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const intent = { id: 'pi_recharge', amount: 2500, currency: 'eur' };
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_recharge', type: 'payment_intent.succeeded', data: { object: intent } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'ready_to_settle', eventId: 'event-row-recharge', sourceType: 'recharge', sourceId: 'REC-1' });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unable to process Stripe webhook' });
    expect(rechargeMocks.confirmStripeRecharge).not.toHaveBeenCalled();
    expect(checkoutMocks.markFinalAndDispatch).not.toHaveBeenCalled();
    expect(providerMocks.markStripeEventProcessed).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[stripe-webhook] Unable to process verified event', {
      eventId: 'evt_recharge', eventType: 'payment_intent.succeeded', error: 'LEGACY_RECHARGE_RETIRED',
    });
  });

  it('settles a wallet recharge through its API checkout with provider and event evidence', async () => {
    const intent = { id: 'pi_recharge_checkout', amount: 2500, currency: 'eur' };
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_recharge_checkout', type: 'payment_intent.succeeded', data: { object: intent } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'ready_to_settle', eventId: 'event-recharge-checkout', sourceType: 'api_payment', sourceId: 'recharge-order-1' });
    checkoutMocks.markFinalAndDispatch.mockResolvedValue({ id: 'recharge-order-1', state: 'paid' });
    const response = await POST({ request: request() } as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(checkoutMocks.markFinalAndDispatch).toHaveBeenCalledExactlyOnceWith('recharge-order-1', 'card', 'pi_recharge_checkout', 'event-recharge-checkout');
    expect(providerMocks.markStripeEventProcessed).toHaveBeenCalledExactlyOnceWith('event-recharge-checkout');
    expect(rechargeMocks.confirmStripeRecharge).not.toHaveBeenCalled();
  });

  it('does not credit a recharge again when Stripe redelivers a processed event', async () => {
    stripeMocks.constructEvent.mockReturnValue({ id: 'evt_recharge', type: 'payment_intent.succeeded', data: { object: {} } });
    providerMocks.consumeStripeEvent.mockResolvedValue({ outcome: 'deduplicated' });

    const response = await POST({ request: request() } as any);

    expect(response.status).toBe(200);
    expect(rechargeMocks.confirmStripeRecharge).not.toHaveBeenCalled();
  });
});
