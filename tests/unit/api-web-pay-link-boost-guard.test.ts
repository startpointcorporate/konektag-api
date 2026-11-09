import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(), connect: vi.fn(), get: vi.fn(), claim: vi.fn(), consume: vi.fn(), markBoost: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.poolQuery, connect: mocks.connect } }));
vi.mock('../../src/application/services/payment-link-service.ts', () => ({
  paymentLinkService: { get: mocks.get, claim: mocks.claim },
}));
vi.mock('../../src/application/services/pay/link-k-consumption-service.ts', () => ({ consumeLinkAtMerchant: mocks.consume }));
vi.mock('../../src/application/services/merchant-social-boost-service.ts', () => ({ markSocialBoostPaid: mocks.markBoost }));

import { POST } from '../../src/api/routes/pay/web/pay-link.ts';

describe('new Web Link Pay Boost guard', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rejects a server-resolved BOOST link before transaction, claim, debit or ERP side effect', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    mocks.get.mockResolvedValue({ status: 'Active', reference: 'BOOST:boost-1' });

    const response = await POST({
      request: new Request('https://api.example.test/api/pay/web/pay-link', { method: 'POST', body: JSON.stringify({ slug: 'boost-link' }) }),
      locals: { user: { id: 'user-1' } },
    } as any);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'BOOST_LINK_NOT_ALLOWED' });
    expect(mocks.poolQuery).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.markBoost).not.toHaveBeenCalled();
  });
});
