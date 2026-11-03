import type { RouteHandler } from '../../../../../http';
import Stripe from 'stripe';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
} from '../../../../../../application/services/pay/api-payment-checkout-service.ts';
import { ProviderConfigurationError, resolveStripeConfiguration } from '../../../../../../infrastructure/adapters/provider-configuration.ts';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: RouteHandler = async ({ params, locals }) => {
  try {
    const order = await apiPaymentCheckoutService.getStripeOrder(params.token || '', locals.user && {
      userId: locals.user.id,
      keycloakId: locals.user.keycloak_id,
      username: locals.user.username,
      email: locals.user.email,
    }, true);
    if (!order.stripePaymentIntentId) {
      throw new ApiPaymentConflictError('Checkout does not have a Stripe PaymentIntent');
    }

    const paymentIntent = await new Stripe(resolveStripeConfiguration(order.providerConfigurationKey).secretKey).paymentIntents.retrieve(order.stripePaymentIntentId);
    if (paymentIntent.metadata.konektag_source_type !== 'api_payment'
      || paymentIntent.metadata.konektag_source_id !== order.id
      || paymentIntent.metadata.konektag_operation_id !== order.id
       || paymentIntent.amount !== order.providerExpectedAmount
      || paymentIntent.currency.toUpperCase() !== order.currency.toUpperCase()) {
      throw new ApiPaymentConflictError('Stored Stripe PaymentIntent does not match this checkout');
    }

    return json({
      status: paymentIntent.status,
      settlement: 'awaiting_webhook',
      message: 'Payment settlement awaits the Stripe webhook.',
    }, 200);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return json({ error: 'Stripe is not configured for this payment' }, 503);
    if (error instanceof ApiPaymentNotFoundError) return json({ error: 'Checkout not found' }, 404);
    if (error instanceof ApiPaymentValidationError) return json({ error: error.message }, 400);
    if (error instanceof ApiPaymentConflictError) return json({ error: error.message }, 409);
    console.error('[api-payment-checkout] Unable to finalize Stripe PaymentIntent', error);
    return json({ error: 'Unable to verify Stripe PaymentIntent' }, 502);
  }
};
