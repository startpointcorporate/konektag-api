import type { RouteHandler } from '../../../http';
import Stripe from 'stripe';
import { getAuthPayload } from '../../../../application/shared/auth-helper.ts';
import { rechargeService } from '../../../../application/services/recharge-service.ts';
import { paymentProviderAttemptService } from '../../../../application/services/pay/payment-provider-attempt-service.ts';

const LIMITS: Record<string, { min: number; max: number }> = {
  xof: { min: 5000, max: 5000000 },
  eur: { min: 500, max: 150000 },
  usd: { min: 500, max: 200000 },
  lbp: { min: 1000000, max: 10000000 },
  aoa: { min: 5000, max: 2000000 },
  cdf: { min: 5000, max: 3000000 },
};
const ZERO_DECIMAL_CURRENCIES = new Set(['xof', 'xaf', 'xpf', 'jpy', 'krw', 'vnd', 'bif', 'clp', 'djf', 'gnf', 'kmf', 'mga', 'pyg', 'rwf', 'ugx', 'vuv']);

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: RouteHandler = async ({ request, cookies, url }) => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: 'Stripe is not configured' }, 503);

  try {
    const body = await request.json();
    const amount = Number(body.amount);
    const currency = String(body.currency || 'xof').toLowerCase();
    const limits = LIMITS[currency];
    if (!limits || !Number.isSafeInteger(amount) || amount < limits.min || amount > limits.max) {
      return json({ error: 'Montant ou devise invalide' }, 400);
    }
    const country = typeof body.country === 'string' && /^[A-Za-z]{2}$/.test(body.country)
      ? body.country.toUpperCase()
      : undefined;
    if (!country) return json({ error: 'Pays requis' }, 400);

    const auth = await getAuthPayload(request, cookies, url.href);
    if (!auth?.sub) return json({ error: 'Non authentifié' }, 401);

    // The ERP source exists before Stripe is contacted and remains pending until its signed webhook arrives.
    const rechargeAmount = ZERO_DECIMAL_CURRENCIES.has(currency) ? amount : amount / 100;
    const { doc } = await rechargeService.createRecharge({
      keycloakId: auth.sub,
      clientEmail: auth.email || auth.sub,
      amount: rechargeAmount,
      currency: currency.toUpperCase(),
      paymentMethod: 'Stripe',
      country,
      status: 'Pending',
    });
    if (!doc.name) throw new Error('Recharge reference is missing');

    const paymentIntent = await new Stripe(secretKey).paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card'],
      metadata: {
        konektag_source_type: 'recharge',
        konektag_source_id: doc.name,
        konektag_operation_id: doc.name,
      },
    }, { idempotencyKey: `recharge:${doc.name}` });
    if (!paymentIntent.client_secret) throw new Error('Stripe did not return a client secret');
    await paymentProviderAttemptService.createStripeRechargeAttempt({ rechargeName: doc.name, paymentIntent });

    return json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, reference: doc.name }, 201);
  } catch (error) {
    // Source details and provider payloads are intentionally never included in this response.
    return json({ error: 'Unable to create Stripe recharge payment' }, 502);
  }
};
