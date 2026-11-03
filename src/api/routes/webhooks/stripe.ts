import { createHash } from 'node:crypto';
import type { RouteHandler } from '../../http';
import Stripe from 'stripe';
import { apiPaymentCheckoutService } from '../../../application/services/pay/api-payment-checkout-service.ts';
import { paymentProviderAttemptService } from '../../../application/services/pay/payment-provider-attempt-service.ts';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: RouteHandler = async ({ request }) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return json({ error: 'Stripe webhook is not configured' }, 503);
  }
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) return json({ error: 'Missing Stripe signature' }, 400);

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = new Stripe(secretKey).webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return json({ error: 'Invalid Stripe signature' }, 400);
  }

  try {
    const paymentIntent = event.type.startsWith('payment_intent.') ? event.data.object as Stripe.PaymentIntent : undefined;
    const consumed = await paymentProviderAttemptService.consumeStripeEvent({
      id: event.id,
      type: event.type,
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
      paymentIntent,
    });
    if ((consumed as any).outcome === 'failed' && (consumed as any).sourceType === 'api_payment') {
      await apiPaymentCheckoutService.handleProviderAttemptFailure((consumed as any).sourceId, (consumed as any).providerReference);
    }
    if (consumed.outcome === 'ready_to_settle') {
      if (consumed.sourceType === 'recharge') {
        throw new Error('LEGACY_RECHARGE_RETIRED');
      } else {
        await apiPaymentCheckoutService.markFinalAndDispatch(consumed.sourceId, 'card', paymentIntent!.id, consumed.eventId);
      }
      await paymentProviderAttemptService.markStripeEventProcessed(consumed.eventId);
    }
    return json({ received: true }, 200);
  } catch (error) {
    // Do not log raw Stripe payloads or card data. A 5xx asks Stripe to retry transient failures.
    console.error('[stripe-webhook] Unable to process verified event', {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return json({ error: 'Unable to process Stripe webhook' }, 500);
  }
};
