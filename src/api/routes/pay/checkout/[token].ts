import type { RouteHandler } from '../../../http';
import { apiPaymentCheckoutService, ApiPaymentNotFoundError } from '../../../../application/services/pay/api-payment-checkout-service.ts';

export const GET: RouteHandler = async ({ params }) => {
  try {
    const checkout = await apiPaymentCheckoutService.getPublicOrder(params.token || '');
    return new Response(JSON.stringify(checkout), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404 : 500;
    return new Response(JSON.stringify({ error: status === 404 ? 'Checkout not found' : 'Unable to load checkout' }), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
};
