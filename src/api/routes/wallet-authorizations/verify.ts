import type { RouteHandler } from '../../http';
import { z } from 'zod';
import {
  walletDebitAuthorizationService,
  WalletDebitAuthorizationError,
  WalletDebitAuthorizationNotFoundError,
  WalletDebitAuthorizationRateLimitError,
} from '../../../application/services/pay/wallet-debit-authorization-service.ts';

const VerifySchema = z.object({
  authorizationId: z.string().uuid(),
  otp: z.string().regex(/^\d{6}$/),
});

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  if (!isSameOrigin(request)) return new Response(JSON.stringify({ error: 'CSRF_REJECTED' }), { status: 403 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
  }
  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 422 });

  try {
    const authorization = await walletDebitAuthorizationService.verify(
      parsed.data.authorizationId,
      parsed.data.otp,
      locals.user.id,
    );
    return new Response(JSON.stringify({ authorization }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error instanceof WalletDebitAuthorizationNotFoundError ? 404
      : error instanceof WalletDebitAuthorizationRateLimitError ? 429
        : error instanceof WalletDebitAuthorizationError ? 409 : 500;
    const code = error instanceof WalletDebitAuthorizationError ? error.code : 'SERVER_ERROR';
    return new Response(JSON.stringify({ error: code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
