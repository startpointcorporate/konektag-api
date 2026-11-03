import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ validateApiKey: vi.fn(), createOrder: vi.fn(), resolveCurrency: vi.fn() }));
vi.mock('../../src/application/services/merchant-api-key-service.ts', () => ({
  merchantApiKeyService: { validateApiKey: mocks.validateApiKey },
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  ApiPaymentValidationError: class extends Error {},
  apiPaymentCheckoutService: { createOrder: mocks.createOrder },
}));
vi.mock('../../src/application/services/operation-currency-service.ts', () => ({
  resolveMerchantOperationCurrency: mocks.resolveCurrency,
}));
// Currency contract is isolated; access denials are covered in pro-entitlement-routes.test.ts.
vi.mock('../../src/application/services/entitlement-decision-service.ts', () => ({
  entitlementDecisionService: { decideForApiPrincipal: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {} }));

import { POST } from '../../src/api/routes/pay/payments.ts';

const request = (body: Record<string, unknown>) => new Request('http://localhost/api/pay/payments', {
  method: 'POST',
  headers: { authorization: 'Bearer sk_test_key' },
  body: JSON.stringify({ subtotal: 1000, transaction_id: 'tx-1', label: 'Invoice', ...body }),
});

describe('API payment creation currency contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue({ merchantProfileId: 'merchant-1', environment: 'sandbox' });
    mocks.createOrder.mockResolvedValue({ order: { id: 'order-1' }, checkoutToken: 'token' });
  });

  it('derives a missing currency from the authenticated merchant legal entity', async () => {
    mocks.resolveCurrency.mockResolvedValue({ country: 'CG', currency: 'XAF', legalEntityId: 'entity-1' });

    const response = await POST({ request: request({}) } as any);

    expect(response.status).toBe(201);
    expect(mocks.resolveCurrency).toHaveBeenCalledWith(expect.anything(), 'merchant-1', undefined);
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({ currency: 'XAF' }));
  });

  it('rejects a currency that is not canonical for the authenticated merchant', async () => {
    mocks.resolveCurrency.mockRejectedValue(new Error('OPERATION_CURRENCY_MISMATCH'));

    const response = await POST({ request: request({ currency: 'XOF' }) } as any);

    expect(response.status).toBe(400);
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it('forwards generic checkout fields (purpose, items, references, redirect URLs)', async () => {
    mocks.resolveCurrency.mockResolvedValue({ country: 'CG', currency: 'XAF', legalEntityId: 'entity-1' });

    const response = await POST({
      request: request({
        purpose: 'invoice_checkout',
        execution_reference: 'invoice-2026-0001',
        items: [
          { reference: 'sku-1', label: 'Article A', quantity: 2, unitAmount: 450, taxAmount: 20 },
          { reference: 'sku-2', label: 'Article B', quantity: 1, unitAmount: 100, taxAmount: 10 },
        ],
        success_url: 'https://merchant.example/success',
        cancel_url: 'https://merchant.example/cancel',
        pending_url: 'https://merchant.example/pending',
        metadata: { checkoutSource: 'erp', channel: 'api' },
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'invoice_checkout',
      executionReference: 'invoice-2026-0001',
      items: expect.arrayContaining([
        expect.objectContaining({ label: 'Article A', quantity: 2, unitAmount: 450, taxAmount: 20 }),
      ]),
      redirectUrls: {
        successUrl: 'https://merchant.example/success',
        cancelUrl: 'https://merchant.example/cancel',
        pendingUrl: 'https://merchant.example/pending',
      },
      metadata: { checkoutSource: 'erp', channel: 'api' },
    }));
  });

  it('supports itemized orders without an explicit subtotal', async () => {
    mocks.resolveCurrency.mockResolvedValue({ country: 'CG', currency: 'XAF', legalEntityId: 'entity-1' });

    const payload = {
      transaction_id: 'tx-2',
      label: 'Invoice',
      payer_identity: 'buyer@example.test',
      items: [{ label: 'Article A', quantity: 1, unitAmount: 900, taxAmount: 100 }],
    };
    const response = await POST({
      request: new Request('http://localhost/api/pay/payments', {
        method: 'POST',
        headers: { authorization: 'Bearer sk_test_key' },
        body: JSON.stringify(payload),
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      subtotalAmount: undefined,
      items: expect.arrayContaining([expect.objectContaining({ unitAmount: 900 })]),
    }));
  });

  it('builds the checkout URL with the requested locale instead of always French', async () => {
    mocks.resolveCurrency.mockResolvedValue({ country: 'CG', currency: 'XAF', legalEntityId: 'entity-1' });

    const response = await POST({
      request: new Request('http://localhost/api/pay/payments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer sk_test_key',
          'accept-language': 'en-US,en;q=0.9',
        },
        body: JSON.stringify({ subtotal: 1000, transaction_id: 'tx-3', label: 'Invoice', payer_identity: 'payer@example.test' }),
      }),
    } as any);

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.checkoutUrl).toContain('/en/pay/checkout/?token=token');
  });
});
