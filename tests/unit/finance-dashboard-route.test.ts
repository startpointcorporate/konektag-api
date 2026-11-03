import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  getLegalEntity: vi.fn(),
  listMerchantSales: vi.fn(),
  getEntityFinancialPosition: vi.fn(),
  listActiveCorridors: vi.fn(),
  listSettlements: vi.fn(),
}));

vi.mock('../../src/application/services/backoffice-permission-service.ts', () => ({
  requireBackofficePermission: () => mocks.permission,
  forbiddenResponse: vi.fn(),
}));
vi.mock('../../src/infrastructure/repositories/finance-read-repository.ts', () => ({
  financeReadRepository: {
    getLegalEntity: mocks.getLegalEntity,
    listMerchantSales: mocks.listMerchantSales,
    getEntityFinancialPosition: mocks.getEntityFinancialPosition,
    listActiveCorridors: mocks.listActiveCorridors,
  },
}));
vi.mock('../../src/application/services/settlement-service.ts', () => ({
  settlementService: { listSettlements: mocks.listSettlements },
}));

import { GET } from '../../src/api/routes/admin/finance/dashboard/[entity].ts';

describe('admin finance dashboard route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue({ authorized: true });
    mocks.getLegalEntity.mockResolvedValue({ code: 'KTG-CG' });
    mocks.listMerchantSales.mockResolvedValue({ data: [], total: 0 });
    mocks.getEntityFinancialPosition.mockResolvedValue([]);
    mocks.listActiveCorridors.mockResolvedValue([]);
    mocks.listSettlements.mockResolvedValue([]);
  });

  it('preserves the response contract using PostgreSQL finance repositories', async () => {
    const response = await GET({ params: { entity: 'KTG-CG' }, locals: {} } as any);

    expect(response.status).toBe(200);
    expect(mocks.listMerchantSales).toHaveBeenCalledWith({ legalEntity: 'KTG-CG', limit: 50 });
    expect(mocks.getEntityFinancialPosition).toHaveBeenCalledWith('KTG-CG');
    expect(await response.json()).toMatchObject({
      entity: { code: 'KTG-CG' },
      kpis: { todaySalesCount: 0 },
      positions: { cashBalance: null, merchantPayable: null, hasInterco: false },
      corridors: [],
      recentSales: [],
      settlements: [],
    });
  });
});
