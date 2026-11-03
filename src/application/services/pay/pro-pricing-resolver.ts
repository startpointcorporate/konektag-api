import { erpnext } from '../../../infrastructure/adapters/erpnext-adapter.ts';
import { minorDigits } from './money-unit.ts';
import type { PaymentContext } from './payment-context-resolver.ts';
import { paymentContextResolver } from './payment-context-resolver.ts';

export type ProPeriod = 'MONTHLY' | 'ANNUAL';

export interface ProPricingResolution {
  itemCode: string;
  period: ProPeriod;
  amountMinor: number;
  currency: string;
  marketCountry: string;
  legalEntityId: string;
  corridor: string;
  pricingSource: 'FRAPPE_EXPLICIT' | 'CORRIDOR_CONVERSION';
}

export class ProPricingResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ProPricingResolutionError';
  }
}

const PRICE_LIST_BY_COUNTRY: Readonly<Record<string, string>> = {
  FR: 'Konektag Pro France',
  CG: 'Konektag Pro Congo',
  CM: 'Konektag Pro Cameroun',
  GA: 'Konektag Pro Gabon',
};

const ITEM_CODE_BY_PERIOD: Readonly<Record<ProPeriod, string>> = {
  MONTHLY: 'KTG-PRO-MONTHLY',
  ANNUAL: 'KTG-PRO-ANNUAL',
};

function toMinorUnits(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new ProPricingResolutionError('PRO_PRICING_INVALID_RATE');
  }

  const factor = 10 ** minorDigits(currency);
  const amountMinor = Math.round(amountMajor * factor);

  if (!Number.isSafeInteger(amountMinor)) {
    throw new ProPricingResolutionError('PRO_PRICING_INVALID_RATE');
  }

  return amountMinor;
}

export async function resolvePricing(
  countryInput: string,
  period: ProPeriod,
): Promise<ProPricingResolution> {
  const country = countryInput.trim().toUpperCase();
  const priceList = PRICE_LIST_BY_COUNTRY[country];

  if (!priceList) {
    throw new ProPricingResolutionError('PRO_PRICING_PRICE_LIST_NOT_CONFIGURED');
  }

  const itemCode = ITEM_CODE_BY_PERIOD[period];

  let context: PaymentContext;
  try {
    context = await paymentContextResolver.resolve(country);
  } catch {
    throw new ProPricingResolutionError('PRO_PRICING_CONTEXT_RESOLUTION_FAILED');
  }

  let itemPrices: Array<{
    name?: string;
    item_code?: string;
    price_list?: string;
    price_list_rate?: number;
    currency?: string;
  }>;

  try {
    itemPrices = await erpnext.list(
      'Item Price',
      { price_list: priceList, item_code: itemCode },
      ['name', 'item_code', 'price_list', 'price_list_rate', 'currency'],
      2,
    );
  } catch {
    throw new ProPricingResolutionError('PRO_PRICING_FRAPPE_UNAVAILABLE');
  }

  if (itemPrices.length === 0) {
    throw new ProPricingResolutionError('PRO_PRICING_ITEM_PRICE_NOT_FOUND');
  }
  if (itemPrices.length > 1) {
    throw new ProPricingResolutionError('PRO_PRICING_ITEM_PRICE_AMBIGUOUS');
  }

  const itemPrice = itemPrices[0];
  if (
    typeof itemPrice.price_list_rate !== 'number' ||
    !itemPrice.currency ||
    itemPrice.item_code !== itemCode ||
    itemPrice.price_list !== priceList
  ) {
    throw new ProPricingResolutionError('PRO_PRICING_INVALID_ITEM_PRICE');
  }

  const corridor = context.providers[0]?.corridor;
  if (!corridor) {
    throw new ProPricingResolutionError('PRO_PRICING_NO_CORRIDOR_FOUND');
  }

  return {
    itemCode,
    period,
    amountMinor: toMinorUnits(itemPrice.price_list_rate, itemPrice.currency),
    currency: itemPrice.currency,
    marketCountry: context.country,
    legalEntityId: context.legalEntity.id,
    corridor,
    pricingSource: 'FRAPPE_EXPLICIT',
  };
}
