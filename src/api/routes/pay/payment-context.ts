import type { RouteHandler } from '../../http';
import { createPaymentContextSelection, PaymentContextResolutionError, paymentContextResolver } from '../../../application/services/pay/payment-context-resolver.ts';

export const GET: RouteHandler = async ({ url }) => {
  const country = url.searchParams.get('country') ?? url.searchParams.get('market') ?? '';
  try {
    const context = await paymentContextResolver.resolve(country);
    return Response.json({
      ...context,
      providers: context.providers.map(provider => ({
        ...provider,
        selectionToken: createPaymentContextSelection({
          country: context.country,
          legalEntityCode: context.legalEntity.code,
          currency: context.currency,
          regulatoryProfileCode: provider.regulatoryProfile.code,
          rail: provider.regulatoryProfile.rail,
          corridor: provider.corridor,
          regulatedActorCode: provider.regulatedActor?.code ?? null,
          provider: provider.provider,
          providerConfigurationKey: provider.providerConfigurationKey,
          paymentMethod: provider.paymentMethod,
          fees: provider.fees,
        }),
      })),
    });
  } catch (error) {
    const code = error instanceof PaymentContextResolutionError ? error.code : 'PAYMENT_CONTEXT_UNAVAILABLE';
    const status = code === 'PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND' ? 404
      : code === 'PAYMENT_CONTEXT_FRAPPE_UNAVAILABLE' ? 503 : 422;
    return Response.json({ error: code }, { status });
  }
};
