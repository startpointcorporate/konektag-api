import type { RouteHandler } from '../../http';
import { paymentContextErrorStatus, PaymentContextResolutionError, paymentContextResolver, publicPaymentContext } from '../../../application/services/pay/payment-context-resolver.ts';

// The country is routed to its Konektag site (FR -> konektag-fr), where the
// legal entity, providers and fees are read.
export const GET: RouteHandler = async ({ url }) => {
  const country = url.searchParams.get('country') ?? url.searchParams.get('market') ?? '';
  try {
    return Response.json(publicPaymentContext(await paymentContextResolver.resolve(country)));
  } catch (error) {
    const code = error instanceof PaymentContextResolutionError ? error.code : 'PAYMENT_CONTEXT_UNAVAILABLE';
    return Response.json({ error: code }, { status: paymentContextErrorStatus(code) });
  }
};
