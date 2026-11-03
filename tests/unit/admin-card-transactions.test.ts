import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

let listQuery: any;
let handler: any;

const row = (overrides = {}) => ({
  provider: 'stripe',
  provider_reference: 'pi_123456789012',
  provider_country: 'CI',
  provider_card_brand: 'visa',
  provider_card_funding: 'credit',
  provider_card_bin: '12345678',
  source_type: 'api_payment',
  source_id: '550e8400-e29b-41d4-a716-446655440000',
  expected_amount: '1250',
  expected_currency: 'EUR',
  state: 'succeeded',
  checkout_settlement_state: 'paid',
  created_at: '2026-07-24T10:00:00.000Z',
  updated_at: '2026-07-24T10:01:00.000Z',
  // These simulate accidental fields on a database driver row. The projection must ignore them.
  metadata: { pan: '4111111111111111', cvc: '123', client_secret: 'secret' },
  pan: '4111111111111111',
  last4: '1111',
  ...overrides,
});

beforeEach(async () => {
  vi.resetAllMocks();
  const queryModule = await import('../../src/application/queries/admin/card-transactions/list.ts');
  const routeModule = await import('../../src/api/routes/admin/card-transactions.ts');
  listQuery = queryModule.adminCardTransactionListQuery;
  handler = routeModule.GET;
});

describe('Admin card transaction query', () => {
  it('uses an explicit safe projection and preserves only an eight-digit BIN', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [row({ provider_card_bin: '1234567' })] });

    const result = await listQuery.list({
      page: 1,
      pageSize: 25,
      provider: 'stripe',
      country: 'CI',
      sourceType: 'api_payment',
      state: 'succeeded',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-24',
    });

    const selectSql = mockPool.query.mock.calls[1][0] as string;
    expect(selectSql).not.toMatch(/\bmetadata\b|\bpan\b|\bcvc\b|\bexpiry\b|\blast4\b|client_secret|raw_payload/i);
    expect(selectSql).toContain("p.created_at < $7::date + INTERVAL '1 day'");
    expect(mockPool.query.mock.calls[0][1]).toEqual([
      ['stripe'], 'stripe', 'CI', 'api_payment', 'succeeded', '2026-07-01', '2026-07-24',
    ]);
    expect(result.data[0]).toEqual({
      provider: 'stripe',
      providerReference: 'pi_123...789012',
      country: 'CI',
      brand: 'visa',
      funding: 'credit',
      bin: null,
      sourceType: 'api_payment',
      sourceRef: '550e8400-e29b-41d4-a716-446655440000',
      expectedAmount: 1250,
      expectedCurrency: 'EUR',
      state: 'succeeded',
      checkoutSettlementState: 'paid',
      createdAt: '2026-07-24T10:00:00.000Z',
      updatedAt: '2026-07-24T10:01:00.000Z',
    });
  });
});

describe('GET /api/admin/card-transactions', () => {
  const context = (url = 'http://localhost/api/admin/card-transactions') => ({
    locals: { user: { id: 'admin-1' } },
    request: new Request(url),
  });

  it('requires the admin role', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'user' }] });

    const response = await handler(context());

    expect(response.status).toBe(403);
  });

  it('does not return prohibited card fields and only returns a valid BIN', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [row()] });

    const response = await handler(context('http://localhost/api/admin/card-transactions?provider=stripe&country=ci&source_type=api_payment&state=succeeded&dateFrom=2026-07-01&dateTo=2026-07-24'));
    const body = await response.json();
    const transaction = body.data[0];

    expect(response.status).toBe(200);
    expect(transaction.bin).toMatch(/^\d{8}$/);
    expect(transaction.providerReference).toBe('pi_123...789012');
    expect(Object.keys(transaction)).toEqual([
      'provider', 'providerReference', 'country', 'brand', 'funding', 'bin', 'sourceType', 'sourceRef',
      'expectedAmount', 'expectedCurrency', 'state', 'checkoutSettlementState', 'createdAt', 'updatedAt',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/metadata|pan|cvc|expiry|last4|client_secret|raw_payload/i);
  });

  it('rejects invalid country, provider, and date windows before querying attempts', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] });
    const response = await handler(context('http://localhost/api/admin/card-transactions?country=CIV'));
    expect(response.status).toBe(400);

    mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] });
    const invalidProvider = await handler(context('http://localhost/api/admin/card-transactions?provider=other'));
    expect(invalidProvider.status).toBe(400);

    mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] });
    const invalidDates = await handler(context('http://localhost/api/admin/card-transactions?dateFrom=2026-07-25&dateTo=2026-07-24'));
    expect(invalidDates.status).toBe(400);
  });
});
