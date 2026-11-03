import { createHash } from 'node:crypto';
import type { RouteHandler } from '../../../http';
import Stripe from 'stripe';
import { apiPaymentCheckoutService } from '../../../../application/services/pay/api-payment-checkout-service.ts';
import { paymentProviderAttemptService } from '../../../../application/services/pay/payment-provider-attempt-service.ts';
import { ProviderConfigurationError, resolveStripeConfiguration } from '../../../../infrastructure/adapters/provider-configuration.ts';

export const POST: RouteHandler = async ({ request, params }) => {
  let event: Stripe.Event | undefined;
  try {
    const configuration = resolveStripeConfiguration(params.configurationKey || null);
    if (!configuration.webhookSecret) return Response.json({ error: 'Stripe webhook is not configured' }, { status: 503 });
    const signature = request.headers.get('Stripe-Signature');
    if (!signature) return Response.json({ error: 'Missing Stripe signature' }, { status: 400 });
    const rawBody = await request.text();
    try { event = new Stripe(configuration.secretKey).webhooks.constructEvent(rawBody, signature, configuration.webhookSecret); }
    catch { return Response.json({ error: 'Invalid Stripe signature' }, { status: 400 }); }
    const paymentIntent = event.type.startsWith('payment_intent.') ? event.data.object as Stripe.PaymentIntent : undefined;
    const consumed = await paymentProviderAttemptService.consumeStripeEvent({ id: event.id, type: event.type, payloadHash: createHash('sha256').update(rawBody).digest('hex'), paymentIntent });
    if ((consumed as any).outcome === 'failed' && (consumed as any).sourceType === 'api_payment') {
      await apiPaymentCheckoutService.handleProviderAttemptFailure((consumed as any).sourceId, (consumed as any).providerReference);
    }
    if (consumed.outcome === 'ready_to_settle') {
      if (consumed.sourceType !== 'api_payment') throw new Error('Stripe provider configuration webhook only supports API payments');
      await apiPaymentCheckoutService.markFinalAndDispatch(consumed.sourceId, 'card', paymentIntent!.id, consumed.eventId);
      const rowCount = await paymentProviderAttemptService.markStripeEventProcessed(consumed.eventId);
      console.info('[stripe-webhook] event processed', { eventId: consumed.eventId, rowCount });
    }
    return Response.json({ received: true });
  } catch (error) {
    console.error('[stripe-webhook] processing failed', { eventId: event?.id, error: error instanceof Error ? error.message : String(error) });
    if (error instanceof ProviderConfigurationError) return Response.json({ error: 'Stripe webhook is not configured' }, { status: 503 });
    return Response.json({ error: 'Stripe webhook processing failed' }, { status: 500 });
  }
};
