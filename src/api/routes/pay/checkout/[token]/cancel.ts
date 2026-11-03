import type { RouteHandler } from '../../../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
} from '../../../../../application/services/pay/api-payment-checkout-service.ts';

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const POST: RouteHandler = async ({ request, params }) => {
  if (!isSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'CSRF_REJECTED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const order = await apiPaymentCheckoutService.cancelCheckout(params.token || '');
    return new Response(JSON.stringify(order), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404
      : error instanceof ApiPaymentValidationError ? 400
        : error instanceof ApiPaymentConflictError ? 409
          : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to cancel checkout' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
