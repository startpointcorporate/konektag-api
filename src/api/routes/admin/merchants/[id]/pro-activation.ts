import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { MerchantProSubscriptionService } from '../../../../../application/services/merchant-pro-subscription-service.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';
import { randomUUID } from 'node:crypto';
import { checkoutExpirationMinutes } from '../../../../../application/services/pay/checkout-expiration.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const access = await requireBackofficePermission('merchants:write')(locals);
  if (!access.authorized || access.user?.role !== 'admin') return null;
  return user;
}

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const profileId = params.id as string;
  if (!profileId) return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });

  try {
    const body = await request.json();
    const { action, subscriptionType, dossierValidated } = body;

    const service = new MerchantProSubscriptionService(pool);

    if (action === 'activate') {
      if (dossierValidated !== true) return Response.json({ error: 'DOSSIER_CONFIRMATION_REQUIRED' }, { status: 400 });
      if (subscriptionType !== 'MONTHLY' && subscriptionType !== 'ANNUAL') return Response.json({ error: 'INVALID_SUBSCRIPTION_TYPE' }, { status: 400 });
      const client = await pool.connect();
      let intentId: string = randomUUID();
      try {
        await client.query('BEGIN');
        const { rows: profiles } = await client.query(
          'SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [profileId]);
        if (!profiles.length) throw new Error('MERCHANT_NOT_FOUND');
        const { rows: subscriptions } = await client.query(
          'SELECT id FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id=$1 LIMIT 1', [profileId]);
        if (subscriptions.length) throw new Error('USE_RENEWAL_FOR_EXISTING_SUBSCRIPTION');
        await client.query(`UPDATE konektag.merchant_pro_renewal_intents i SET status='CANCELLED'
          FROM konektag.api_payment_orders o WHERE i.payment_order_id=o.id AND i.merchant_profile_id=$1
          AND i.subscription_id IS NULL AND i.status='PENDING'
          AND (o.state IN ('expired','failed','cancelled')
          OR o.created_at < now() - ($2::int * interval '1 minute'))`, [profileId, checkoutExpirationMinutes()]);
        await client.query(`UPDATE konektag.merchant_pro_renewal_intents SET status='CANCELLED'
          WHERE merchant_profile_id=$1 AND subscription_id IS NULL AND status='PENDING'
          AND payment_order_id IS NULL AND created_at < now() - interval '30 minutes'`, [profileId]);
        const { rows: [pending] } = await client.query<{ id: string; subscription_type: string; payment_order_id: string | null }>(
          `SELECT id,subscription_type,payment_order_id FROM konektag.merchant_pro_renewal_intents
           WHERE merchant_profile_id=$1 AND subscription_id IS NULL AND status='PENDING' FOR UPDATE`, [profileId]);
        if (pending) {
          if (pending.subscription_type !== subscriptionType || pending.payment_order_id)
            throw new Error('INITIAL_PAYMENT_ALREADY_PENDING');
          intentId = pending.id;
        } else {
          await client.query(`INSERT INTO konektag.merchant_pro_renewal_intents
            (id,merchant_profile_id,subscription_id,request_key,subscription_type,initial_approved_by,initial_approved_at)
            VALUES ($1,$2,NULL,$3,$4,$5,now())`, [intentId, profileId, randomUUID(), subscriptionType, admin.id]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
      const base = process.env.PUBLIC_SITE_URL || request.url;
      const checkoutUrl = new URL(`/api/merchant/pro-renewal-links/${intentId}?lang=fr`, base).toString();
      return Response.json({ success: true, checkoutUrl, paymentIntentId: intentId, status: 'AWAITING_PAYMENT' }, { status: 201 });
    } else if (action === 'deactivate') {
      const updatedSubscription = await service.cancelAtEnd(profileId);

      return new Response(JSON.stringify({
        success: true,
        subscription: updatedSubscription
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ error: 'INVALID_ACTION', validActions: ['activate', 'deactivate'] }), { status: 400 });
    }
  } catch (error: any) {
    console.error('[admin/merchants/pro-activation]', error);
    if (error.message === 'SUBSCRIPTION_ALREADY_ACTIVE') return Response.json({ error: error.message }, { status: 409 });
    if (error.message === 'USE_RENEWAL_FOR_EXISTING_SUBSCRIPTION'
      || error.message === 'INITIAL_PAYMENT_ALREADY_PENDING' || error.code === '23505')
      return Response.json({ error: 'INITIAL_PAYMENT_ALREADY_PENDING_OR_SUBSCRIBED' }, { status: 409 });
    if (error.message === 'NO_SUBSCRIPTION_FOUND' || error.message === 'MERCHANT_NOT_FOUND') return Response.json({ error: error.message }, { status: 404 });
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500 });
  }
};
