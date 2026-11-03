import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  erpnextList: vi.fn(),
}));

vi.mock('../../src/application/services/pay/payment-context-resolver.ts', () => ({
  paymentContextResolver: { resolve: mocks.resolveContext },
}));

vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts', () => ({
  erpnext: { list: mocks.erpnextList },
}));

import {
  ProPricingResolutionError,
  resolvePricing,
} from '../../src/application/services/pay/pro-pricing-resolver.ts';

function context(country: string, legalEntityId: string, corridor: string) {
  return {
    country,
    legalEntity: { id: legalEntityId, code: `KTG-${country}`, legalName: `Konektag ${country}` },
    providers: [{ corridor }],
  } as any;
}

describe('resolvePricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves FR monthly from the configured Price List and converts EUR to minor units', async () => {
    mocks.resolveContext.mockResolvedValue(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    mocks.erpnextList.mockResolvedValue([{
      name: 'IP-FR-MONTHLY',
      item_code: 'KTG-PRO-MONTHLY',
      price_list: 'Konektag Pro France',
      price_list_rate: 89,
      currency: 'EUR',
    }]);

    const result = await resolvePricing('fr', 'MONTHLY');

    expect(mocks.resolveContext).toHaveBeenCalledWith('FR');
    expect(mocks.erpnextList).toHaveBeenCalledWith(
      'Item Price',
      { price_list: 'Konektag Pro France', item_code: 'KTG-PRO-MONTHLY' },
      ['name', 'item_code', 'price_list', 'price_list_rate', 'currency'],
      2,
    );
    expect(result).toMatchObject({
      itemCode: 'KTG-PRO-MONTHLY',
      period: 'MONTHLY',
      amountMinor: 8900,
      currency: 'EUR',
      marketCountry: 'FR',
      legalEntityId: 'LE-FR-123',
      corridor: 'CORRIDOR-FR',
      pricingSource: 'FRAPPE_EXPLICIT',
    });
  });

  it('resolves FR annual and converts 1014 EUR to 101400 minor units', async () => {
    mocks.resolveContext.mockResolvedValue(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    mocks.erpnextList.mockResolvedValue([{
      name: 'IP-FR-ANNUAL',
      item_code: 'KTG-PRO-ANNUAL',
      price_list: 'Konektag Pro France',
      price_list_rate: 1014,
      currency: 'EUR',
    }]);

    const result = await resolvePricing('FR', 'ANNUAL');
    expect(result.amountMinor).toBe(101400);
    expect(result.itemCode).toBe('KTG-PRO-ANNUAL');
  });

  it.each([
    ['CG', 'Konektag Pro Congo'],
    ['CM', 'Konektag Pro Cameroun'],
    ['GA', 'Konektag Pro Gabon'],
  ])('resolves %s monthly XAF without multiplying by 100', async (country, priceList) => {
    mocks.resolveContext.mockResolvedValue(context(country, `LE-${country}`, `CORRIDOR-${country}`));
    mocks.erpnextList.mockResolvedValue([{
      name: `IP-${country}-MONTHLY`,
      item_code: 'KTG-PRO-MONTHLY',
      price_list: priceList,
      price_list_rate: 59000,
      currency: 'XAF',
    }]);

    const result = await resolvePricing(country, 'MONTHLY');
    expect(result.amountMinor).toBe(59000);
    expect(mocks.erpnextList).toHaveBeenCalledWith(
      'Item Price',
      { price_list: priceList, item_code: 'KTG-PRO-MONTHLY' },
      ['name', 'item_code', 'price_list', 'price_list_rate', 'currency'],
      2,
    );
  });

  it('uses the actual Frappe rate rather than a hard-coded expected price', async () => {
    mocks.resolveContext.mockResolvedValue(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    mocks.erpnextList.mockResolvedValue([{
      name: 'IP-FR-MONTHLY',
      item_code: 'KTG-PRO-MONTHLY',
      price_list: 'Konektag Pro France',
      price_list_rate: 91.25,
      currency: 'EUR',
    }]);

    const result = await resolvePricing('FR', 'MONTHLY');
    expect(result.amountMinor).toBe(9125);
  });

  it('fails before PaymentContext resolution when the country has no Price List mapping', async () => {
    await expect(resolvePricing('US', 'MONTHLY')).rejects.toMatchObject({
      code: 'PRO_PRICING_PRICE_LIST_NOT_CONFIGURED',
    });
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.erpnextList).not.toHaveBeenCalled();
  });

  it('distinguishes a missing Item Price', async () => {
    mocks.resolveContext.mockResolvedValue(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    mocks.erpnextList.mockResolvedValue([]);

    await expect(resolvePricing('FR', 'MONTHLY')).rejects.toMatchObject({
      code: 'PRO_PRICING_ITEM_PRICE_NOT_FOUND',
    });
  });

  it('distinguishes an ambiguous Item Price configuration', async () => {
    mocks.resolveContext.mockResolvedValue(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    const price = {
      item_code: 'KTG-PRO-MONTHLY',
      price_list: 'Konektag Pro France',
      price_list_rate: 89,
      currency: 'EUR',
    };
    mocks.erpnextList.mockResolvedValue([{ name: 'IP-1', ...price }, { name: 'IP-2', ...price }]);

    await expect(resolvePricing('FR', 'MONTHLY')).rejects.toMatchObject({
      code: 'PRO_PRICING_ITEM_PRICE_AMBIGUOUS',
    });
  });

  it('reports PaymentContext failures separately from Frappe failures', async () => {
    mocks.resolveContext.mockRejectedValueOnce(new Error('context unavailable'));
    await expect(resolvePricing('FR', 'MONTHLY')).rejects.toMatchObject({
      code: 'PRO_PRICING_CONTEXT_RESOLUTION_FAILED',
    });

    mocks.resolveContext.mockResolvedValueOnce(context('FR', 'LE-FR-123', 'CORRIDOR-FR'));
    mocks.erpnextList.mockRejectedValueOnce(new Error('frappe unavailable'));
    await expect(resolvePricing('FR', 'MONTHLY')).rejects.toMatchObject({
      code: 'PRO_PRICING_FRAPPE_UNAVAILABLE',
    });
  });
});
