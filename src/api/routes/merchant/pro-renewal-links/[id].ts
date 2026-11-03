import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { detectCountry } from '../../../../application/services/pay/detected-country-service.ts';
import { paymentCountryResolver } from '../../../../application/services/pay/payment-country-resolver.ts';
import { paymentContextResolver } from '../../../../application/services/pay/payment-context-resolver.ts';
import { exchangeRateService } from '../../../../application/services/exchange-rate-service.ts';
import { proPrice, type ProPeriod } from '../../../../application/services/subscription-pricing.ts';
import { convertEurMinor, minorDigits } from '../../../../application/services/pay/money-unit.ts';
import { supportsProPaymentProvider } from '../../../../application/services/pay/pro-payment-provider.ts';
import { apiPaymentCheckoutService } from '../../../../application/services/pay/api-payment-checkout-service.ts';

export const GET: RouteHandler = async ({ params, request, url }) => {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'INVALID_LINK' }, { status: 404 });

  const client = await pool.connect();
  let intent: { merchant_profile_id: string; subscription_type: ProPeriod; merchant_country: string | null };
  let attempt: number;
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(`SELECT i.*,mp.country AS merchant_country
      FROM konektag.merchant_pro_renewal_intents i
      JOIN konektag.merchant_profiles mp ON mp.id=i.merchant_profile_id AND mp.deleted_at IS NULL
      WHERE i.id=$1 FOR UPDATE OF i`, [id]);
    if (!row || row.status !== 'PENDING' || row.payment_order_id
      || new Date(row.created_at).getTime() + 30 * 60_000 <= Date.now()) {
      await client.query('ROLLBACK');
      return Response.json({ error: 'LINK_ALREADY_USED_OR_EXPIRED' }, { status: 410 });
    }
    intent = row;
    attempt = Number(row.checkout_attempts) + 1;
    await client.query('UPDATE konektag.merchant_pro_renewal_intents SET checkout_attempts=$2 WHERE id=$1', [id, attempt]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }

  const detected = await detectCountry(request) ?? intent.merchant_country;
  if (!detected) return Response.json({ error: 'PAYMENT_COUNTRY_REQUIRED' }, { status: 422 });
  let country: string, currency: string, legalEntityCode: string;
  try { country = (await paymentCountryResolver.resolve(detected)).paymentCountry; }
  catch { return Response.json({ error: 'PAYMENT_COUNTRY_MAPPING_NOT_FOUND' }, { status: 503 }); }
  try {
    const context = await paymentContextResolver.resolve(country);
    currency = context.currency;
    legalEntityCode = context.legalEntity.code;
    minorDigits(currency);
    if (!context.providers.some(provider => supportsProPaymentProvider(provider, currency, country))) {
      return Response.json({ error: 'PRO_EXTERNAL_PROVIDER_UNAVAILABLE' }, { status: 503 });
    }
  } catch { return Response.json({ error: 'PRO_CURRENCY_CORRIDOR_UNAVAILABLE' }, { status: 503 }); }
  const { rows: networkMerchants } = await pool.query<{ id: string }>(
    `SELECT mp.id FROM konektag.merchant_profiles mp
     JOIN konektag.legal_entities le ON le.id=mp.legal_entity_id
     WHERE le.code=$1 AND le.status='APPROVED' AND le.deleted_at IS NULL
       AND mp.beneficiary_type='NETWORK' AND mp.deleted_at IS NULL LIMIT 2`, [legalEntityCode]);
  if (networkMerchants.length !== 1) return Response.json({ error: 'PRO_NETWORK_MERCHANT_UNAVAILABLE' }, { status: 503 });

  const basePrice = proPrice(intent.subscription_type);
  const fx = currency === 'EUR' ? null : await exchangeRateService.getRateEvidence('EUR', currency);
  if (currency !== 'EUR' && !fx) return Response.json({ error: 'PRO_EXCHANGE_RATE_UNAVAILABLE' }, { status: 503 });
  let amountMinor: number;
  try { amountMinor = fx ? convertEurMinor(basePrice.amountMinor, currency, fx.rate, fx.inverse) : basePrice.amountMinor; }
  catch { return Response.json({ error: 'PRO_EXCHANGE_RATE_INVALID' }, { status: 503 }); }

  const result = await apiPaymentCheckoutService.createOrder({
    merchantProfileId: networkMerchants[0].id, environment: 'live',
    merchantTransactionId: `PRO-${id}-${attempt}`, purpose: 'pro_subscription_renewal', amountUnit: 'MINOR',
    label: `Konektag Pro ${intent.subscription_type === 'MONTHLY' ? 'mensuel' : 'annuel'}`,
    payerIdentity: `merchant:${intent.merchant_profile_id}`, currency,
    subtotalAmount: amountMinor, taxAmount: 0, cashbackAmount: 0,
    metadata: { renewalIntentId: id, merchantProfileId: intent.merchant_profile_id,
      period: intent.subscription_type, paymentCountry: country,
      exchangeRateId: fx?.id ?? null, exchangeRate: fx?.rate ?? null,
      exchangeRateInverse: fx?.inverse ?? false, exchangeRateSource: fx?.source ?? null,
      exchangeRateTimestamp: fx?.valuedAt ?? null },
  });
  if (!result.checkoutToken) return Response.json({ error: 'CHECKOUT_CREATION_FAILED' }, { status: 503 });
  const { rowCount } = await pool.query(`UPDATE konektag.merchant_pro_renewal_intents SET
    payment_order_id=$2,price_minor=$3,currency=$4,payment_country=$5,
    exchange_rate_id=$6,exchange_rate=$7,exchange_rate_inverse=$8,
    exchange_rate_source=$9,exchange_rate_timestamp=$10
    WHERE id=$1 AND status='PENDING' AND payment_order_id IS NULL`,
    [id, result.order.id, amountMinor, currency, country, fx?.id ?? null, fx?.rate ?? null,
      fx?.inverse ?? false, fx?.source ?? null, fx?.valuedAt ?? null]);
  if (!rowCount) return Response.json({ error: 'LINK_ALREADY_USED' }, { status: 410 });
  const lang = url.searchParams.get('lang')?.match(/^[a-z]{2}$/)?.[0] ?? 'fr';
  return Response.redirect(new URL(`/${lang}/pay/checkout/?token=${encodeURIComponent(result.checkoutToken)}`, url), 303);
};
