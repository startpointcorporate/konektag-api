import type { RouteHandler } from '../../../../http';
import { randomUUID } from 'node:crypto';
import pool from '../../../../../infrastructure/database/pool.ts';
import { MerchantProSubscriptionService } from '../../../../../application/services/merchant-pro-subscription-service.ts';
import { renewalOpensAt } from '../../../../../application/services/subscription-pricing.ts';
import { entitlementDecisionService, entitlementResponse } from '../../../../../application/services/entitlement-decision-service.ts';
import { checkoutExpirationMinutes } from '../../../../../application/services/pay/checkout-expiration.ts';

export const POST: RouteHandler = async ({ request, params, locals }) => {
  if (!locals.user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const merchantId = params.profileId!;
  const decision = await entitlementDecisionService.decide({ actorId: locals.user.id, merchantId, capability: 'membership.manage' });
  if (!decision.allowed) return entitlementResponse(decision);
  let body: { renewal_type?: string };
  try { body = await request.json(); } catch { return Response.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const period = body.renewal_type;
  if (period !== 'MONTHLY' && period !== 'ANNUAL') return Response.json({ error: 'INVALID_PERIOD' }, { status: 400 });
  const requestKey = request.headers.get('Idempotency-Key') || randomUUID();
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) return Response.json({ error: 'INVALID_IDEMPOTENCY_KEY' }, { status: 400 });

  const service = new MerchantProSubscriptionService(pool);
  const now = new Date();
  const { subscription } = await service.resolveSubscription(merchantId, now);
  if (!subscription || !['ACTIVE', 'EXPIRED'].includes(subscription.status) || !subscription.subscription_end) {
    return Response.json({ error: 'NO_RENEWABLE_SUBSCRIPTION' }, { status: 400 });
  }
  const end = new Date(subscription.subscription_end);
  if (end > now && now < renewalOpensAt(end, subscription.subscription_type)) {
    return Response.json({ error: 'RENEWAL_NOT_OPEN' }, { status: 400 });
  }
  const intentId = randomUUID();
  try {
    await pool.query(`UPDATE konektag.merchant_pro_renewal_intents i SET status='CANCELLED'
      FROM konektag.api_payment_orders o WHERE i.payment_order_id=o.id AND i.subscription_id=$1
      AND i.status='PENDING' AND (o.state IN ('expired','failed','cancelled')
      OR o.created_at < now() - ($2::int * interval '1 minute'))`, [subscription.id, checkoutExpirationMinutes()]);
    await pool.query(`UPDATE konektag.merchant_pro_renewal_intents SET status='CANCELLED'
      WHERE subscription_id=$1 AND status='PENDING' AND payment_order_id IS NULL
      AND created_at < now() - interval '30 minutes'`, [subscription.id]);
    await pool.query(`INSERT INTO konektag.merchant_pro_renewal_intents
      (id,merchant_profile_id,subscription_id,request_key,subscription_type)
      VALUES ($1,$2,$3,$4,$5)`, [intentId, merchantId, subscription.id, requestKey, period]);
  } catch (error: any) {
    if (error.code === '23505') return Response.json({ error: 'RENEWAL_ALREADY_PENDING' }, { status: 409 });
    throw error;
  }
  const base = process.env.PUBLIC_SITE_URL || request.url;
  const locale = locals.user.locale || 'fr';
  const checkoutUrl = new URL(`/api/merchant/pro-renewal-links/${intentId}?lang=${encodeURIComponent(locale)}`, base).toString();
  return Response.json({ checkoutUrl, renewalIntentId: intentId }, { status: 201 });
};
