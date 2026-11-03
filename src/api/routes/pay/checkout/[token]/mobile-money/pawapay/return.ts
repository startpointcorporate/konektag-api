import type { RouteHandler } from '../../../../../../http';
import { pawaPayDepositService } from '../../../../../../../application/services/pay/pawapay-deposit-service.ts';
import { pawaPayClient } from '../../../../../../../infrastructure/adapters/pawapay-client.ts';
import { paymentProviderAttemptService } from '../../../../../../../application/services/pay/payment-provider-attempt-service.ts';
import { getPublicOrigin } from '../../../../../../../application/shared/public-origin.ts';
import { getPaymentLocale } from '../../../../../../../application/catalogs/payment/catalog.ts';

export const GET: RouteHandler = async ({ request, params, url }) => {
  // The browser return is never a settlement signal. Reconciliation only trusts PawaPay's status API.
  const depositId = url.searchParams.get('depositId');
  if (depositId) {
    try {
      const deposit = await pawaPayClient.getDeposit(depositId, await paymentProviderAttemptService.getPawaPayConfigurationKey(depositId));
      await pawaPayDepositService.consume(deposit, JSON.stringify(deposit));
    } catch {
      // The callback/reconciliation cycle remains authoritative when PawaPay is not ready or unavailable.
    }
  }
  const origin = getPublicOrigin(new URL(request.url).origin, (process.env.NODE_ENV !== 'production'));
  const locale = getPaymentLocale(url.searchParams.get('lang') ?? undefined);
  return Response.redirect(`${origin}/${encodeURIComponent(locale)}/pay/checkout/pending?token=${encodeURIComponent(params.token || '')}`, 303);
};
