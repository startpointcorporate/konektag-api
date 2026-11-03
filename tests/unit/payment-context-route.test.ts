import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), createSelection: vi.fn() }));
vi.mock('../../src/application/services/pay/payment-context-resolver.ts', () => ({
  PaymentContextResolutionError: class extends Error { constructor(public code: string) { super(code); } },
  paymentContextResolver: { resolve: mocks.resolve },
  createPaymentContextSelection: mocks.createSelection,
}));

import { GET } from '../../src/api/routes/pay/payment-context.ts';

describe('GET /api/pay/payment-context', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.createSelection.mockReturnValue('signed-selection'); });

  it('returns the resolved France payment context without creating a payment', async () => {
    mocks.resolve.mockResolvedValue({ country: 'FR', legalEntity: { code: 'KTG-FR' }, currency: 'EUR', providers: [{ regulatoryProfile: { code: 'LINK-FR-STRIPE', rail: 'stripe' }, corridor: 'KTG-FR-KTG-FR', regulatedActor: null, provider: 'stripe', providerConfigurationKey: 'KTG_FR_STRIPE_TEST', paymentMethod: 'card', fees: { percentageBps: 300, fixedAmount: 0 } }] });
    const response = await GET({ url: new URL('http://localhost/api/pay/payment-context?country=FR') } as any);
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('FR');
    expect(await response.json()).toMatchObject({ country: 'FR', legalEntity: { code: 'KTG-FR' }, providers: [{ provider: 'stripe', paymentMethod: 'card', selectionToken: 'signed-selection' }] });
  });

  it('supports market and reports resolution errors', async () => {
    mocks.resolve.mockRejectedValue(new (await import('../../src/application/services/pay/payment-context-resolver.ts')).PaymentContextResolutionError('PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND'));
    const response = await GET({ url: new URL('http://localhost/api/pay/payment-context?market=ZZ') } as any);
    expect(response.status).toBe(404);
    expect(mocks.resolve).toHaveBeenCalledWith('ZZ');
    expect(await response.json()).toEqual({ error: 'PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND' });
  });
});
