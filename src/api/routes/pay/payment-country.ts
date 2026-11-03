import type { RouteHandler } from '../../http';
import { PaymentCountryResolutionError, paymentCountryResolver } from '../../../application/services/pay/payment-country-resolver.ts';

export const GET: RouteHandler = async ({ url }) => {
  try {
    return Response.json(await paymentCountryResolver.resolve(url.searchParams.get('detectedCountry') ?? ''));
  } catch (error) {
    const code = error instanceof PaymentCountryResolutionError ? error.code : 'PAYMENT_COUNTRY_UNAVAILABLE';
    const status = code === 'PAYMENT_COUNTRY_INVALID' ? 400
      : code === 'PAYMENT_COUNTRY_MAPPING_NOT_FOUND' ? 404 : 422;
    return Response.json({ error: code }, { status });
  }
};
