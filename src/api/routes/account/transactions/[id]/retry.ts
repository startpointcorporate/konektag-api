import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { apiPaymentCheckoutService } from '../../../../../application/services/pay/api-payment-checkout-service.ts';

const RETRYABLE = new Set(['failed', 'expired', 'cancelled']);

export const POST: RouteHandler = async ({ params, locals, request }) => {
  const user = locals.user;
  if (!user?.id) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const { rows } = await pool.query<{
    id: string; order_purpose: string; target_user_id: string | null; state: string;
    currency: string; payment_country: string | null; subtotal_amount: number | string;
  }>(
    `SELECT id,order_purpose,target_user_id,state,currency,payment_country,subtotal_amount
     FROM konektag.api_payment_orders
     WHERE id=$1 AND target_user_id=$2
     LIMIT 1`,
    [params.id, user.id],
  );
  const order = rows[0];
  if (!order) return Response.json({ error: 'TRANSACTION_NOT_FOUND' }, { status: 404 });
  if (!RETRYABLE.has(order.state)) return Response.json({ error: 'TRANSACTION_NOT_RETRYABLE' }, { status: 409 });
  if (order.order_purpose !== 'wallet_recharge') return Response.json({ error: 'RETRY_NOT_SUPPORTED_FOR_TRANSACTION_TYPE' }, { status: 422 });

  const amount = Number(order.subtotal_amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return Response.json({ error: 'INVALID_ORIGINAL_AMOUNT' }, { status: 409 });

  if (!order.payment_country) return Response.json({ error: 'ORIGINAL_PAYMENT_COUNTRY_REQUIRED' }, { status: 409 });

  const result = await apiPaymentCheckoutService.createWalletRechargeOrder({
    targetUserId: user.id,
    amount,
    currency: order.currency,
    paymentCountry: order.payment_country,
  });
  if (!result.checkoutToken) return Response.json({ error: 'UNABLE_TO_CREATE_RETRY_CHECKOUT' }, { status: 409 });

  const lang = new URL(request.url).searchParams.get('lang') || user.locale || 'fr';
  return Response.json({
    originalTransactionId: order.id,
    transactionId: result.order.id,
    checkoutUrl: `/${encodeURIComponent(lang)}/pay/checkout/?token=${encodeURIComponent(result.checkoutToken)}`,
  }, { status: 201 });
};
