import type { RouteHandler } from '../../../../../http';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
} from '../../../../../../application/services/pay/api-payment-checkout-service.ts';
import { paymentProviderAttemptService } from '../../../../../../application/services/pay/payment-provider-attempt-service.ts';
import { ProviderConfigurationError, resolveStripeConfiguration } from '../../../../../../infrastructure/adapters/provider-configuration.ts';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: RouteHandler = async ({ params, locals }) => {
  try {
    const order = await apiPaymentCheckoutService.getStripeOrder(params.token || '', locals?.user && {
      userId: locals.user.id,
      keycloakId: locals.user.keycloak_id,
      username: locals.user.username,
      email: locals.user.email,
    });
    const configuration = resolveStripeConfiguration(order.providerConfigurationKey);
    const stripe = new Stripe(configuration.secretKey);
    const expectedAmount = order.providerExpectedAmount;
    await paymentProviderAttemptService.expireStaleApiPaymentAttempts(order.id);
    const reuseStoredIntent = order.stripePaymentIntentId
      && await paymentProviderAttemptService.hasActiveApiPaymentAttempt(order.id);
    const attemptKey = randomUUID();
    const paymentIntent = reuseStoredIntent
      ? await stripe.paymentIntents.retrieve(order.stripePaymentIntentId!)
      : await stripe.paymentIntents.create({
        amount: expectedAmount,
        currency: order.currency.toLowerCase(),
        payment_method_types: ['card'],
        metadata: {
          konektag_source_type: 'api_payment',
          konektag_source_id: order.id,
          konektag_operation_id: order.id,
        },
      }, { idempotencyKey: `api-payment-order:${order.id}:attempt:${attemptKey}` });

    if (paymentIntent.metadata.konektag_source_type !== 'api_payment'
      || paymentIntent.metadata.konektag_source_id !== order.id
      || paymentIntent.metadata.konektag_operation_id !== order.id
      || paymentIntent.amount !== expectedAmount
      || paymentIntent.currency.toUpperCase() !== order.currency.toUpperCase()) {
      throw new ApiPaymentConflictError('Stored Stripe PaymentIntent does not match this checkout');
    }
    if (!paymentIntent.client_secret) throw new Error('Stripe did not return a client secret');

    await apiPaymentCheckoutService.attachStripePaymentIntent(params.token || '', paymentIntent.id);
    await paymentProviderAttemptService.createOrUpdateStripeApiCheckoutAttempt({
      orderId: order.id,
      paymentIntent,
      metadata: order.providerConfigurationKey ? { providerConfigurationKey: order.providerConfigurationKey } : undefined,
    });
    return json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: configuration.publishableKey,
      paymentIntentId: paymentIntent.id,
    }, 201);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return json({ error: 'Stripe is not configured: STRIPE_PUBLISHABLE_KEY is required' }, 503);
    if (error instanceof ApiPaymentNotFoundError) return json({ error: 'Checkout not found' }, 404);
    if (error instanceof ApiPaymentValidationError) return json({ error: error.message }, 400);
    if (error instanceof ApiPaymentConflictError) return json({ error: error.message }, 409);
    console.error('[api-payment-checkout] Unable to create Stripe PaymentIntent', error);
    return json({ error: 'Unable to create Stripe PaymentIntent' }, 502);
  }
};
