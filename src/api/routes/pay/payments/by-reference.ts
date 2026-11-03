import type { RouteHandler } from '../../../http';
import { merchantApiKeyService } from '../../../../application/services/merchant-api-key-service.ts';
import { apiPaymentCheckoutService } from '../../../../application/services/pay/api-payment-checkout-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';

/**
 * Additive, read-only ERP/third-party reconciliation endpoint.
 * Existing POST /api/pay/payments and GET /api/pay/payments/:id remain unchanged.
 * The checkout token is intentionally NOT reissued on retries.
 */
export const GET: RouteHandler = async ({ request, url }) => {
  const authorization = request.headers.get('authorization') || '';
  const key = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const merchant = await merchantApiKeyService.validateApiKey(key);
  if (!merchant) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const reference = url.searchParams.get('transaction_id')?.trim() || '';
  if (!reference || reference.length > 255) {
    return Response.json({ error: 'transaction_id required (max 255 characters)' }, { status: 400 });
  }
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM konektag.api_payment_orders
       WHERE merchant_profile_id = $1 AND environment = $2
         AND merchant_transaction_id = $3
       LIMIT 1`,
      [merchant.merchantProfileId, merchant.environment, reference],
    );
    if (!rows[0]) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    const order = await apiPaymentCheckoutService.getOrder(rows[0].id, {
      merchantProfileId: merchant.merchantProfileId,
    });
    return Response.json({ order }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api-payment-reference] Unable to resolve payment reference', error);
    return Response.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
};
