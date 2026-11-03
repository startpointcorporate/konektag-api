import type { RouteHandler } from '../../http';
import { paymentCountryResolver } from '../../../application/services/pay/payment-country-resolver.ts';
import { formatMinor, minorDigits } from '../../../application/services/pay/money-unit.ts';
import { supportsProPaymentProvider } from '../../../application/services/pay/pro-payment-provider.ts';
import { ProPricingResolutionError, resolvePricing } from '../../../application/services/pay/pro-pricing-resolver.ts';

export const GET: RouteHandler = async ({ url }) => {
  const country = url.searchParams.get('country')?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(country)) {
    return Response.json({ error: 'INVALID_COUNTRY' }, { status: 400 });
  }

  try {
    const paymentCountry = (await paymentCountryResolver.resolve(country)).paymentCountry;
    const monthlyPricing = await resolvePricing(paymentCountry, 'MONTHLY');
    const annualPricing = await resolvePricing(paymentCountry, 'ANNUAL');

    if (monthlyPricing.currency !== annualPricing.currency) {
      return Response.json({ error: 'PRO_PRICING_CURRENCY_MISMATCH' }, { status: 503 });
    }

    const currency = monthlyPricing.currency;

    if (
      !supportsProPaymentProvider({ provider: 'stripe', paymentMethod: 'card' }, currency, paymentCountry) &&
      !supportsProPaymentProvider({ provider: 'pawapay', paymentMethod: 'mobile_money' }, currency, paymentCountry)
    ) {
      return Response.json({ error: 'PRO_EXTERNAL_PROVIDER_UNAVAILABLE' }, { status: 503 });
    }

    minorDigits(currency);

    const quote = (pricing: typeof monthlyPricing) => ({
      amountMinor: pricing.amountMinor,
      display: formatMinor(pricing.amountMinor, currency),
    });

    return Response.json(
      {
        country,
        paymentCountry,
        currency,
        monthly: quote(monthlyPricing),
        annual: quote(annualPricing),
        pricingSource: monthlyPricing.pricingSource,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ProPricingResolutionError) {
      return Response.json({ error: error.code }, { status: 503 });
    }
    return Response.json({ error: 'PRO_PRICE_UNAVAILABLE' }, { status: 503 });
  }
};
