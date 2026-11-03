import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

let listQuery: any;
let handler: any;

const row = (overrides = {}) => ({
  authorization_id: '00000000-0000-4000-8000-000000000001',
  lifecycle: 'consumed',
  operation_type: 'transfer',
  operation_id: 'transfer-42',
  amount: '1250',
  currency: 'XOF',
  payee_display_name: 'Recipient',
  payee_reference: 'merchant-42',
  payee_masked_identifier: '***1234',
  issued_at: '2026-07-24T10:00:00.000Z',
  approved_at: '2026-07-24T10:01:00.000Z',
  consumed_at: '2026-07-24T10:02:00.000Z',
  expires_at: '2026-07-24T10:05:00.000Z',
  attempts: '1',
  resend_count: '0',
  accounting_transaction_id: '00000000-0000-4000-8000-000000000002',
  accounting_transaction_status: 'completed',
  accounting_amount: '1250',
  // Simulate unsafe columns accidentally returned by a database driver row.
  otp_hash: 'secret-otp-hash',
  otp_salt: 'secret-otp-salt',
  email: 'payer@example.test',
  email_delivery_status: 'failed',
  delivery_error: 'provider response',
  raw_payee_payload: { email: 'payee@example.test' },
  redis_key: 'wallet-debit-authorization:issue:user-1',
  ...overrides,
});

beforeEach(async () => {
  vi.resetAllMocks();
  const queryModule = await import('../../src/application/queries/admin/wallet-history/list.ts');
  const routeModule = await import('../../src/api/routes/admin/wallet-history.ts');
  listQuery = queryModule.adminWalletHistoryQuery;
  handler = routeModule.GET;
});

describe('Admin wallet history query', () => {
  it('uses a safe projection and returns a financial transaction only for one exact reference/type match', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [row()] });

    const result = await listQuery.list({
      page: 1,
      pageSize: 25,
      lifecycle: 'consumed',
      operationType: 'transfer',
      currency: 'XOF',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-24',
      payer: 'payer-1',
    });

    const selectSql = mockPool.query.mock.calls[1][0] as string;
    expect(selectSql).toContain("ft.business_reference = a.operation_id");
    expect(selectSql).toContain("WHEN 'transfer' THEN 'transfer'");
    expect(selectSql).toContain('f.candidate_count = 1');
    expect(selectSql).not.toMatch(/otp_hash|otp_salt|email_delivery_status|delivery_error|redis_key/i);
    expect(mockPool.query.mock.calls[0][1]).toEqual([
      'consumed', 'transfer', 'XOF', '2026-07-01', '2026-07-24', '%payer-1%',
    ]);
    expect(result.data).toEqual([{
      id: '00000000-0000-4000-8000-000000000001',
      lifecycle: 'consumed',
      operationType: 'transfer',
      operationId: 'transfer-42',
      amount: 1250,
      currency: 'XOF',
      payeeSnapshot: { displayName: 'Recipient', reference: 'merchant-42', maskedIdentifier: '***1234' },
      issuedAt: '2026-07-24T10:00:00.000Z',
      approvedAt: '2026-07-24T10:01:00.000Z',
      consumedAt: '2026-07-24T10:02:00.000Z',
      expiresAt: '2026-07-24T10:05:00.000Z',
      attempts: 1,
      resendCount: 0,
      accountingTransaction: {
        id: '00000000-0000-4000-8000-000000000002', status: 'completed', amount: 1250,
      },
    }]);
  });
});

describe('GET /api/admin/wallet-history', () => {
  const context = (url = 'http://localhost/api/admin/wallet-history') => ({
    locals: { user: { id: 'admin-1' } },
    request: new Request(url),
  });

  it('requires the admin role', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'user' }] });

    const response = await handler(context());

    expect(response.status).toBe(403);
  });

  it('never returns authentication, delivery, email, raw payee, or Redis fields', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [row()] });

    const response = await handler(context('http://localhost/api/admin/wallet-history?lifecycle=consumed&operationType=transfer&currency=xof&dateFrom=2026-07-01&dateTo=2026-07-24&payer=payer-1'));
    const body = await response.json();
    const authorization = body.data[0];

    expect(response.status).toBe(200);
    expect(Object.keys(authorization)).toEqual([
      'id', 'lifecycle', 'operationType', 'operationId', 'amount', 'currency', 'payeeSnapshot',
      'issuedAt', 'approvedAt', 'consumedAt', 'expiresAt', 'attempts', 'resendCount', 'accountingTransaction',
    ]);
    expect(Object.keys(authorization.payeeSnapshot)).toEqual(['displayName', 'reference', 'maskedIdentifier']);
    expect(JSON.stringify(body)).not.toMatch(/otp|salt|email|raw_payee|delivery|redis|secret|provider response/i);
  });
});
