import type { RouteHandler } from '../../../../../../http';
import { apiPaymentCheckoutService, ApiPaymentConflictError, ApiPaymentNotFoundError, ApiPaymentValidationError } from '../../../../../../../application/services/pay/api-payment-checkout-service.ts';
import { paymentProviderAttemptService } from '../../../../../../../application/services/pay/payment-provider-attempt-service.ts';
import { pawaPayClient, PawaPayError } from '../../../../../../../infrastructure/adapters/pawapay-client.ts';
import { getPublicOrigin } from '../../../../../../../application/shared/public-origin.ts';
import { getPaymentLocale } from '../../../../../../../application/catalogs/payment/catalog.ts';

function localeFromReferer(request: Request): string | null {
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    const pathSegments = new URL(referer).pathname.split('/').filter(Boolean);
    return pathSegments[0] || null;
  } catch {
    return null;
  }
}

export const POST: RouteHandler = async ({ request, params, locals }) => {
  try {
    let bodyLang: string | null = null;
    try {
      const body = await request.json() as { lang?: unknown };
      if (typeof body.lang === 'string' && body.lang.trim()) bodyLang = body.lang.trim();
    } catch {
      bodyLang = null;
    }

    const payer = locals.user && { userId: locals.user.id, keycloakId: locals.user.keycloak_id, username: locals.user.username, email: locals.user.email };
    const order = await apiPaymentCheckoutService.getMobileMoneyOrder(params.token || '', payer);
    const depositId = await paymentProviderAttemptService.createOrGetPawaPayApiCheckoutAttempt({ orderId: order.id, amount: order.externalAmount, currency: order.currency, providerConfigurationKey: order.providerConfigurationKey });
    const result = await apiPaymentCheckoutService.confirmCheckout(params.token || '', 'mobile_money', payer);
    const origin = getPublicOrigin(new URL(request.url).origin, (process.env.NODE_ENV !== 'production'));
    const locale = getPaymentLocale(bodyLang ?? localeFromReferer(request) ?? undefined);
    const returnUrl = `${origin}/api/pay/checkout/${encodeURIComponent(params.token || '')}/mobile-money/pawapay/return?lang=${encodeURIComponent(locale)}`;
    const redirectUrl = await pawaPayClient.createPaymentPage({
      depositId,
      returnUrl,
      amount: order.externalAmount,
      currency: order.currency,
      country: order.paymentCountry,
      reason: `Konektag ${order.id}`.slice(0, 50),
      metadata: [{ paymentOrderId: order.id }],
      providerConfigurationKey: order.providerConfigurationKey,
    });
    return Response.json({ redirectUrl, state: result.order.state }, { status: 201 });
  } catch (error) { const status = error instanceof ApiPaymentNotFoundError ? 404 : error instanceof ApiPaymentValidationError ? 400 : error instanceof ApiPaymentConflictError ? 409 : error instanceof PawaPayError ? 502 : 500; return Response.json({ error: error instanceof Error ? error.message : 'Unable to start PawaPay deposit' }, { status }); }
};
