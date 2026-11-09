import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), claim: vi.fn(), query: vi.fn(), connect: vi.fn(),
  consume: vi.fn(), receipt: vi.fn(), activation: vi.fn(), kyc: vi.fn(),
}));

vi.mock('../../src/application/services/principal-idempotency-service.ts', () => ({
  beginPrincipalAttempt: vi.fn(), completePrincipalAttempt: vi.fn(),
  readPrincipalReplay: vi.fn().mockResolvedValue(null),
  principalCommandHash: vi.fn().mockReturnValue('hash'),
  principalAttemptKey: vi.fn().mockReturnValue('attempt'),
  PrincipalReplayConflict: class extends Error {},
}));
vi.mock('../../src/application/services/link-payment-receipt-service.ts', () => ({ sendLinkPaymentReceipt: mocks.receipt }));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: mocks.activation } }));
vi.mock('../../src/application/services/payment-link-service.ts', () => ({ paymentLinkService: { get: mocks.get, claim: mocks.claim } }));
vi.mock('../../src/application/services/pay/link-k-consumption-service.ts', () => ({ consumeLinkAtMerchant: mocks.consume }));
vi.mock('../../src/application/services/user-kyc-gate-service.ts', () => ({ checkUserKycVerified: mocks.kyc }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query, connect: mocks.connect } }));

import { POST } from '../../src/api/routes/pay/pay-link.ts';

describe('retired Boost payment links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({
      status: 'Active', reference: 'BOOST:historical-id', merchant: 'merchant-id',
      amount: 1000, currency: 'EUR', quantityK: 10, valuation: { proofHash: 'proof' },
    });
  });

  it('rejects an already-issued BOOST link before claim, debit, receipt or ERP-adjacent work', async () => {
    const response = await POST({
      request: new Request('https://api.test/api/pay/pay-link', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'legacy-boost' }),
      }),
      locals: { user: { id: 'payer' } },
    } as any);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: 'BOOST_PAYMENT_RETIRED' });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.receipt).not.toHaveBeenCalled();
    expect(mocks.activation).not.toHaveBeenCalled();
    expect(mocks.kyc).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
