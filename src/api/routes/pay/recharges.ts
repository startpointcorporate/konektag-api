import type { RouteHandler } from '../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentValidationError,
} from '../../../application/services/pay/api-payment-checkout-service.ts';
import { minorDigits } from '../../../application/services/pay/money-unit.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Array.isArray(body) || typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount <= 0
      || typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)
      || typeof body.paymentCountry !== 'string' || !/^[A-Z]{2,3}$/.test(body.paymentCountry)) {
      throw new ApiPaymentValidationError('amount must be a positive integer and currency must be a three-letter uppercase code and paymentCountry must be a valid country code');
    }
    try { minorDigits(body.currency); }
    catch { throw new ApiPaymentValidationError('currency is not supported for minor-unit wallet recharge'); }
    const result = await apiPaymentCheckoutService.createWalletRechargeOrder({
      targetUserId: locals.user.id,
      amount: body.amount,
      currency: body.currency,
      paymentCountry: body.paymentCountry,
    });
    const origin = process.env.PUBLIC_SITE_URL || new URL(request.url).origin;
    const checkoutUrl = new URL(`/fr/pay/checkout/?token=${encodeURIComponent(result.checkoutToken)}`, origin).toString();
    return Response.json({ id: result.order.id, status: result.order.state, checkoutUrl,
      amountMinor: body.amount, amountUnit: 'MINOR', currency: body.currency, paymentCountry: body.paymentCountry,
    }, { status: 201 });
  } catch (error) {
    const status = error instanceof ApiPaymentValidationError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to create wallet recharge' }, { status });
  }
};
