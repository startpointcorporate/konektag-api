import type { RouteHandler } from '../../../http';
import { apiPaymentCheckoutService, ApiPaymentNotFoundError } from '../../../../application/services/pay/api-payment-checkout-service.ts';

export const POST: RouteHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await apiPaymentCheckoutService.exchangeResumeToken(String(body.resumeToken || ''));
    return Response.json(result);
  } catch (error) {
    if (error instanceof ApiPaymentNotFoundError) {
      return Response.json({ error: 'Resume link is invalid or expired' }, { status: 404 });
    }
    throw error;
  }
};
