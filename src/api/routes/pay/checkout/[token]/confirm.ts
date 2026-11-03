import type { RouteHandler } from '../../../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
  type ApiPaymentMethod,
} from '../../../../../application/services/pay/api-payment-checkout-service.ts';

const METHODS = new Set<ApiPaymentMethod>(['sandbox', 'wallet', 'card', 'mobile_money']);

export const POST: RouteHandler = async ({ request, params, locals }) => {
  try {
    const body = await request.json() as { paymentMethod?: unknown };
    if (typeof body.paymentMethod !== 'string' || !METHODS.has(body.paymentMethod as ApiPaymentMethod)) {
      throw new ApiPaymentValidationError('paymentMethod must be sandbox, wallet, card, or mobile_money');
    }
    const payer = locals.user && {
      userId: locals.user.id,
      keycloakId: locals.user.keycloak_id,
      username: locals.user.username,
      email: locals.user.email,
    };
    if (body.paymentMethod === 'wallet' && !payer) {
      return new Response(JSON.stringify({ error: 'Authentication is required for Wallet payments' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const result = await apiPaymentCheckoutService.confirmCheckout(params.token || '', body.paymentMethod as ApiPaymentMethod, payer);
    const status = result.outcome === 'awaiting_mobile_money' ? 409 : 200;
    return new Response(JSON.stringify(result.order), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404
      : error instanceof ApiPaymentValidationError ? 400
        : error instanceof ApiPaymentConflictError ? 409
          : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to confirm checkout' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
