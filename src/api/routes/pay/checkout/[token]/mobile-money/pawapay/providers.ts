import type { RouteHandler } from '../../../../../../http';
import { ApiPaymentConflictError, ApiPaymentNotFoundError, ApiPaymentValidationError } from '../../../../../../../application/services/pay/api-payment-checkout-service.ts';
import { listPawaPayDepositProviders, PawaPayDirectDepositError } from '../../../../../../../application/services/pay/pawapay-direct-deposit-service.ts';
import { PawaPayError } from '../../../../../../../infrastructure/adapters/pawapay-client.ts';
import { ProviderConfigurationError } from '../../../../../../../infrastructure/adapters/provider-configuration.ts';

/** Mobile Money operators really active on the corridor account for this checkout amount. */
export const GET: RouteHandler = async ({ params, locals }) => {
  try {
    const payer = locals.user && { userId: locals.user.id, keycloakId: locals.user.keycloak_id, username: locals.user.username, email: locals.user.email };
    return Response.json(await listPawaPayDepositProviders(params.token || '', payer), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof PawaPayDirectDepositError) return Response.json({ error: error.code }, { status: error.status });
    const status = error instanceof ApiPaymentNotFoundError ? 404 : error instanceof ApiPaymentValidationError ? 400
      : error instanceof ApiPaymentConflictError ? 409 : error instanceof ProviderConfigurationError ? 503 : error instanceof PawaPayError ? 502 : 500;
    return Response.json({ error: status === 500 ? 'Unable to read PawaPay providers' : (error as Error).message }, { status });
  }
};
