import { entitlementDecisionService, entitlementResponse } from '../../../application/services/entitlement-decision-service.ts';
import type { RouteHandler } from '../../http';
import { merchantApiKeyService } from '../../../application/services/merchant-api-key-service.ts';
import {
  apiPaymentCheckoutService,
  ApiPaymentValidationError,
  type CreateApiPaymentOrderInput,
} from '../../../application/services/pay/api-payment-checkout-service.ts';
import { resolveMerchantOperationCurrency } from '../../../application/services/operation-currency-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { getPaymentLocale } from '../../../application/catalogs/payment/catalog.ts';

function resolveCheckoutLocale(request: Request, body: Record<string, unknown>): string {
  const bodyLocale = typeof body.lang === 'string' && body.lang.trim()
    ? body.lang.trim()
    : typeof body.locale === 'string' && body.locale.trim()
      ? body.locale.trim()
      : null;
  if (bodyLocale) {
    return getPaymentLocale(bodyLocale.toLowerCase().split('-')[0]);
  }

  const acceptLanguage = request.headers.get('accept-language');
  if (acceptLanguage) {
    const candidate = acceptLanguage.split(',')[0]?.trim().toLowerCase().split('-')[0];
    if (candidate) return getPaymentLocale(candidate);
  }

  return 'fr';
}

export const POST: RouteHandler = async ({ request }) => {
  const authHeader = request.headers.get('authorization') || '';
  const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const merchant = await merchantApiKeyService.validateApiKey(key);
  if (!merchant) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 });
  }

  try {
    const decision = await entitlementDecisionService.decideForApiPrincipal(merchant.merchantProfileId);
    if (!decision.allowed) return entitlementResponse(decision);
    const body = await request.json() as Record<string, unknown>;
    if (!body || Array.isArray(body)) {
      throw new ApiPaymentValidationError('Request body must be an object');
    }
    const {
      subtotal,
      tax,
      cashback,
      label,
      payer_identity,
      transaction_id,
      currency,
      purpose,
      execution_reference,
      items,
      metadata,
      success_url,
      cancel_url,
      pending_url,
      successUrl,
      cancelUrl,
      pendingUrl,
    } = body;
    if (purpose === 'pro_subscription_renewal') {
      return Response.json({ error: 'Reserved payment purpose' }, { status: 403 });
    }
    const operationContext = await resolveMerchantOperationCurrency(
      pool,
      merchant.merchantProfileId,
      currency,
    ).catch((error: Error) => {
      throw new ApiPaymentValidationError(error.message);
    });

    if ('total' in body || 'total_amount' in body || 'totalAmount' in body
      || 'fee' in body || 'fee_amount' in body || 'feeAmount' in body) {
      return new Response(JSON.stringify({ error: 'total and fee are calculated by Konektag' }), { status: 400 });
    }

    const result = await apiPaymentCheckoutService.createOrder({
      merchantProfileId: merchant.merchantProfileId,
      environment: merchant.environment,
      merchantTransactionId: typeof transaction_id === 'string' ? transaction_id : '',
      purpose: typeof purpose === 'string' ? purpose : undefined,
      executionReference: typeof execution_reference === 'string' ? execution_reference : undefined,
      label: typeof label === 'string' ? label : '',
      payerIdentity: typeof payer_identity === 'string' ? payer_identity : '',
      items: Array.isArray(items) ? items as CreateApiPaymentOrderInput['items'] : undefined,
      redirectUrls: {
        successUrl: typeof success_url === 'string' ? success_url : typeof successUrl === 'string' ? successUrl : undefined,
        cancelUrl: typeof cancel_url === 'string' ? cancel_url : typeof cancelUrl === 'string' ? cancelUrl : undefined,
        pendingUrl: typeof pending_url === 'string' ? pending_url : typeof pendingUrl === 'string' ? pendingUrl : undefined,
      },
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : undefined,
      currency: operationContext.currency,
      subtotalAmount: subtotal === undefined ? undefined : Number(subtotal),
      taxAmount: tax === undefined ? undefined : Number(tax),
      cashbackAmount: cashback === undefined ? 0 : Number(cashback),
    });

    if (!result.checkoutToken) {
      return new Response(JSON.stringify({
        ...result.order,
        error: 'An order already exists for this merchant transaction ID; its checkout token cannot be reissued.',
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    const publicSiteUrl = process.env.PUBLIC_SITE_URL || request.url;
    const checkoutLocale = resolveCheckoutLocale(request, body);
    const checkoutUrl = new URL(`/${checkoutLocale}/pay/checkout/?token=${encodeURIComponent(result.checkoutToken)}`, publicSiteUrl).toString();
    return new Response(JSON.stringify({ ...result.order, checkoutUrl }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const status = err instanceof ApiPaymentValidationError ? 400 : 500;
    return new Response(JSON.stringify({ error: err.message || 'Unable to create payment order' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
