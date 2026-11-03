import type { RouteHandler } from '../../../http';
import Stripe from 'stripe';
import { getAuthPayload } from '../../../../application/shared/auth-helper.ts';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: RouteHandler = async ({ request, cookies, url }) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'Stripe is not configured' }, 503);

  try {
    const body = await request.json();
    const paymentIntentId = typeof body.paymentIntentId === 'string' ? body.paymentIntentId : '';
    if (!paymentIntentId.startsWith('pi_')) return json({ error: 'paymentIntentId requis' }, 400);
    if (!await getAuthPayload(request, cookies, url.href)) return json({ error: 'Non authentifié' }, 401);

    const paymentIntent = await new Stripe(secretKey).paymentIntents.retrieve(paymentIntentId);
    const metadata = paymentIntent.metadata;
    if (metadata.konektag_source_type !== 'recharge' || !metadata.konektag_source_id
      || metadata.konektag_operation_id !== metadata.konektag_source_id) {
      return json({ error: 'PaymentIntent invalide pour cette recharge' }, 409);
    }
    return json({
      status: paymentIntent.status,
      settlement: 'awaiting_webhook',
      message: 'La confirmation de la recharge attend le webhook Stripe.',
    }, 200);
  } catch {
    return json({ error: 'Unable to verify Stripe PaymentIntent' }, 502);
  }
};
