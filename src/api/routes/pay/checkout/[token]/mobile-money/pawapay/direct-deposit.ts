import { z } from 'zod';
import type { RouteHandler } from '../../../../../../http';
import { ApiPaymentConflictError, ApiPaymentNotFoundError, ApiPaymentValidationError } from '../../../../../../../application/services/pay/api-payment-checkout-service.ts';
import { PawaPayDirectDepositError, startPawaPayDirectDeposit } from '../../../../../../../application/services/pay/pawapay-direct-deposit-service.ts';
import { PawaPayError } from '../../../../../../../infrastructure/adapters/pawapay-client.ts';
import { ProviderConfigurationError } from '../../../../../../../infrastructure/adapters/provider-configuration.ts';
import { PawaPaySandboxPolicyError } from '../../../../../../../infrastructure/adapters/pawapay-sandbox-policy.ts';

// The amount is never accepted from the browser: it is the frozen ERPNext Payment Request of the checkout.
const body = z.object({
  phoneNumber: z.string().trim().min(6).max(32).regex(/^\+?[0-9 ()-]+$/),
  provider: z.string().regex(/^[A-Z0-9_]{3,80}$/).optional(),
}).strict();

export const POST: RouteHandler = async ({ request, params, locals }) => {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  try {
    const payer = locals.user && { userId: locals.user.id, keycloakId: locals.user.keycloak_id, username: locals.user.username, email: locals.user.email };
    return Response.json(await startPawaPayDirectDeposit(params.token || '', payer, parsed.data), { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof PawaPaySandboxPolicyError) return Response.json({ error: error.code }, { status: 503 });
    if (error instanceof PawaPayDirectDepositError) return Response.json({ error: error.code, ...error.detail }, { status: error.status });
    const status = error instanceof ApiPaymentNotFoundError ? 404 : error instanceof ApiPaymentValidationError ? 400
      : error instanceof ApiPaymentConflictError ? 409 : error instanceof ProviderConfigurationError ? 503 : error instanceof PawaPayError ? 502 : 500;
    if (status >= 500) console.error('[pawapay-direct-deposit] failed', { error: (error as Error).message });
    return Response.json({ error: status === 500 ? 'Unable to start PawaPay deposit' : (error as Error).message }, { status });
  }
};
