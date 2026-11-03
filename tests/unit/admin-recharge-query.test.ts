import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

let adminRechargeListQuery: any;
let adminRechargeDetailQuery: any;

beforeEach(async () => {
  vi.resetAllMocks();
  const listMod = await import('../../src/application/queries/admin/recharges/list.ts');
  const detailMod = await import('../../src/application/queries/admin/recharges/detail.ts');
  adminRechargeListQuery = listMod.adminRechargeListQuery;
  adminRechargeDetailQuery = detailMod.adminRechargeDetailQuery;
});

function mockRow(overrides = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    recharge_name: 'KTG-RECH-00001',
    keycloak_id: 'kc-user-1',
    user_id: 'uu-1',
    user_name: 'jean',
    requested_amount: 5000,
    requested_currency: 'XOF',
    credited_amount: null,
    credited_currency: null,
    payment_method: 'mobile_money',
    payment_provider: 'MTN',
    payment_provider_name: 'MTN Mobile Money',
    recharge_status: 'pending',
    provider_status_detail: null,
    ledger_status: 'not_posted',
    provider_reference: null,
    internal_reference: 'web-12345',
    country: 'CI',
    created_at: '2026-07-19T10:00:00Z',
    updated_at: '2026-07-19T10:00:00Z',
    confirmed_at: null,
    reversed_at: null,
    anomaly: null,
    ...overrides,
  };
}

describe('AdminRechargeListQuery', () => {
  it('returns empty result when no rows', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    const result = await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
    });
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it('returns paginated results with correct shape', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [mockRow()] });

    const result = await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].rechargeName).toBe('KTG-RECH-00001');
    expect(result.data[0].rechargeStatus).toBe('pending');
    expect(result.data[0].ledgerStatus).toBe('not_posted');
    expect(result.data[0].paymentMethod).toBe('mobile_money');
    expect(result.data[0].paymentProviderName).toBe('MTN Mobile Money');
    expect(result.data[0].hasAnomaly).toBe(false);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.total).toBe(1);
    expect(result.pagination.hasMore).toBe(false);
  });

  it('builds WHERE clause for rechargeStatus filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      rechargeStatus: 'pending',
    });
    const query = mockPool.query.mock.calls[0][0] as string;
    expect(query).toContain('r.recharge_status');
    expect(mockPool.query.mock.calls[0][1]).toContain('pending');
  });

  it('builds WHERE clause for paymentMethod filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      paymentMethod: 'card',
    });
    expect(mockPool.query.mock.calls[0][0]).toContain('r.payment_method');
  });

  it('includes notCredited filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      notCredited: true,
    });
    expect(mockPool.query.mock.calls[0][0]).toContain('credited_amount IS NULL');
  });

  it('includes hasAnomaly filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      hasAnomaly: true,
    });
    expect(mockPool.query.mock.calls[0][0]).toContain('r.anomaly IS NOT NULL');
  });

  it('uses correct ORDER BY and LIMIT/OFFSET', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: 50 }] })
      .mockResolvedValueOnce({ rows: [mockRow()] });
    await adminRechargeListQuery.list({
      page: 2, pageSize: 10, sort: 'created_at', direction: 'asc',
    });
    const query = mockPool.query.mock.calls[1][0] as string;
    expect(query).toContain('ORDER BY r.created_at ASC');
    expect(query).toContain('LIMIT');
    expect(query).toContain('OFFSET');
  });

  it('includes search filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      search: 'KTG-RECH',
    });
    expect(mockPool.query.mock.calls[0][1]).toContain('%KTG-RECH%');
  });

  it('includes date range filter', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ total: 0 }] });
    await adminRechargeListQuery.list({
      page: 1, pageSize: 25, sort: 'created_at', direction: 'desc',
      dateFrom: '2026-01-01', dateTo: '2026-12-31',
    });
    const vals = mockPool.query.mock.calls[0][1];
    expect(vals).toContain('2026-01-01');
    expect(vals).toContain('2026-12-31');
  });
});

describe('AdminRechargeDetailQuery', () => {
  it('returns null when recharge not found', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const result = await adminRechargeDetailQuery.getById('nonexistent');
    expect(result).toBeNull();
  });

  it('returns full detail for existing recharge', async () => {
    const row = mockRow({
      keycloak_id: 'kc-1', user_id: 'u-1', user_keycloak_id: 'kc-1',
      user_name: 'jean', user_locale: 'fr', user_country: 'CI',
      user_state: 'COMPLETED', user_role: 'user',
      user_banned_at: null, user_created_at: '2026-01-01',
      recharge_status: 'confirmed',
      credited_amount: 5000, credited_currency: 'XOF',
      provider_reference: 'PI_12345',
    });

    mockPool.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ balance: 15000 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await adminRechargeDetailQuery.getById('550e8400-e29b-41d4-a716-446655440000');
    expect(result).not.toBeNull();
    expect(result!.rechargeName).toBe('KTG-RECH-00001');
    expect(result!.rechargeStatus).toBe('confirmed');
    expect(result!.creditedAmount).toBe(5000);
    expect(result!.user).not.toBeNull();
    expect(result!.user!.username).toBe('jean');
    expect(result!.walletBalance).toBe(15000);
  });

  it('looks up by id or recharge_name', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    await adminRechargeDetailQuery.getById('KTG-RECH-00001');
    expect(mockPool.query.mock.calls[0][0]).toContain('r.id = $1 OR r.recharge_name = $1');
  });
});
