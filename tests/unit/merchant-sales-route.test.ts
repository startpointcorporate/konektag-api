import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMerchantSales: vi.fn(),
  summarizeMerchantSales: vi.fn(),
}));

vi.mock('../../src/infrastructure/repositories/finance-read-repository.ts', () => ({
  financeReadRepository: mocks,
}));

import { GET } from '../../src/api/routes/merchant/sales/index.ts';

describe('GET /api/merchant/sales', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rejects unauthenticated reads', async () => {
    const response = await GET({
      request: new Request('http://localhost/api/merchant/sales'), locals: {},
    } as any);
    expect(response.status).toBe(401);
    expect(mocks.listMerchantSales).not.toHaveBeenCalled();
  });

  it('returns the summary contract for the logged-in merchant', async () => {
    mocks.summarizeMerchantSales.mockResolvedValue({ today: { gross: 10 } });
    const response = await GET({
      request: new Request('http://localhost/api/merchant/sales?summary=1'),
      locals: { user: { id: 'merchant-user' } },
    } as any);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ today: { gross: 10 } });
    expect(mocks.summarizeMerchantSales).toHaveBeenCalledWith('merchant-user');
  });

  it('passes the authenticated merchant scope and filters to PostgreSQL', async () => {
    mocks.listMerchantSales.mockResolvedValue({
      data: [{ gross_amount: '10', commission_amount: '1', net_payable: '9', k_quantity: '10' }], total: 1,
    });
    const response = await GET({
      request: new Request('http://localhost/api/merchant/sales?currency=EUR&page=2'),
      locals: { user: { id: 'merchant-user' } },
    } as any);
    expect(mocks.listMerchantSales).toHaveBeenCalledWith(expect.objectContaining({
      merchantUserId: 'merchant-user', currency: 'EUR', page: 2, limit: 25,
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: [{ gross_amount: 10, commission_amount: 1, net_payable: 9, k_quantity: 10 }],
      total: 1, page: 2, pageSize: 25,
    });
  });
});
