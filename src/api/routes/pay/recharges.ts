import type { RouteHandler } from '../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentValidationError,
} from '../../../application/services/pay/api-payment-checkout-service.ts';
import { KonektagSiteError, konektagSiteErrorStatus } from '../../../application/shared/konektag-site.ts';
import { paymentContextErrorStatus, PaymentContextResolutionError, publicPaymentContext } from '../../../application/services/pay/payment-context-resolver.ts';
import { PointsKPurchaseRoutingError, routePointsKPurchase } from '../../../application/services/pay/points-k-purchase-routing.ts';

/**
 * Points K purchase. The Konektag site comes from the buyer's residence
 * country, resolved server-side; its payment context and fees are read there
 * before the checkout is created and returned with it. A `paymentCountry` sent
 * by the client is ignored.
 */
export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Array.isArray(body) || typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount <= 0
      || typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
      throw new ApiPaymentValidationError('amount must be a positive integer and currency must be a three-letter uppercase code');
    }
    const { route, context } = await routePointsKPurchase(locals.user.id);
    if (context.currency !== body.currency) {
      return Response.json({ error: 'PAYMENT_CURRENCY_MISMATCH', currency: context.currency }, { status: 409 });
    }
    const result = await apiPaymentCheckoutService.createWalletRechargeOrder({
      targetUserId: locals.user.id,
      amount: body.amount,
      currency: context.currency,
      paymentCountry: route.paymentCountry,
      konektagSite: { slug: route.slug },
    });
    const origin = process.env.PUBLIC_SITE_URL || new URL(request.url).origin;
    if (!result.checkoutToken) return Response.json({ error: 'CHECKOUT_ALREADY_EXISTS', id: result.order.id }, { status: 409 });
    const checkoutUrl = new URL(`/fr/pay/checkout/?token=${encodeURIComponent(result.checkoutToken)}`, origin).toString();
    return Response.json({
      id: result.order.id, status: result.order.state, checkoutUrl,
      konektagSite: route.slug,
      paymentContext: publicPaymentContext(context),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof KonektagSiteError) return Response.json({ error: error.code }, { status: konektagSiteErrorStatus(error) });
    if (error instanceof PaymentContextResolutionError) return Response.json({ error: error.code }, { status: paymentContextErrorStatus(error.code) });
    if (error instanceof PointsKPurchaseRoutingError) return Response.json({ error: error.code }, { status: 404 });
    const status = error instanceof ApiPaymentValidationError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to create wallet recharge' }, { status });
  }
};
