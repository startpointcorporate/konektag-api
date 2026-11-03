import type { RouteHandler } from '../../../../http';
import { z } from 'zod';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
} from '../../../../../application/services/pay/api-payment-checkout-service.ts';
import {
  WalletDebitAuthorizationDeliveryError,
  WalletDebitAuthorizationError,
  WalletDebitAuthorizationRateLimitError,
} from '../../../../../application/services/pay/wallet-debit-authorization-service.ts';

const EmptyBody = z.object({}).strict();

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export const POST: RouteHandler = async ({ request, params, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  if (!isSameOrigin(request)) return new Response(JSON.stringify({ error: 'CSRF_REJECTED' }), { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 }); }
  if (!EmptyBody.safeParse(body).success) return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 422 });

  try {
    const result = await apiPaymentCheckoutService.issueWalletAuthorization(params.token || '', {
      userId: locals.user.id,
      keycloakId: locals.user.keycloak_id,
      username: locals.user.username,
      email: locals.user.email,
    });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404
      : error instanceof WalletDebitAuthorizationRateLimitError ? 429
        : error instanceof WalletDebitAuthorizationDeliveryError ? 503
          : error instanceof ApiPaymentValidationError ? 400
            : error instanceof ApiPaymentConflictError || error instanceof WalletDebitAuthorizationError ? 409 : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'SERVER_ERROR' }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }
};
