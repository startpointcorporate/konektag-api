import type { RouteHandler } from '../../../http';
import { apiPaymentCheckoutService } from '../../../../application/services/pay/api-payment-checkout-service.ts';
import { merchantApiKeyService } from '../../../../application/services/merchant-api-key-service.ts';

export const GET: RouteHandler = async ({ params, request, locals }) => {
  try {
    if (!params.id) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    const authHeader = request.headers.get('authorization') || '';
    const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const merchant = apiKey ? await merchantApiKeyService.validateApiKey(apiKey) : null;
    const user = (locals as any).user;
    if (!merchant && !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const order = await apiPaymentCheckoutService.getOrder(params.id, {
      merchantProfileId: merchant?.merchantProfileId,
      userId: merchant ? undefined : user.id,
    });
    return new Response(JSON.stringify({ order }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 404 });
  }
};
