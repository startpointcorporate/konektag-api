import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ poolQuery: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), finalize: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.poolQuery, connect: mocks.connect } }));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({ apiPaymentCheckoutService: { markFinalAndDispatch: mocks.finalize } }));

import { MobileMoneyConfirmationError, parseMobileMoneyConfirmation, persistMobileMoneyReceipt } from '../../src/application/commands/admin/mobile-money-confirmation.ts';
import { adminMobileMoneyQueueQuery } from '../../src/application/queries/admin/mobile-money-queue/list.ts';
import { confirmApiPaymentMobileMoney } from '../../src/application/commands/admin/confirm-api-payment-mobile-money-command.ts';

const input = { provider: 'MTN', country: 'CI', operator: 'MTN', providerReference: 'MM-1234', amount: 5000, currency: 'XOF', receivedAt: '2026-07-24T12:00:00.000Z', maskedSender: '***1234' };

describe('Mobile Money admin queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it('rejects raw sender data and never maps it into queue rows', async () => {
    expect(() => parseMobileMoneyConfirmation({ ...input, maskedSender: '+2250102030405' })).toThrow('maskedSender');
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] }).mockResolvedValueOnce({ rows: [{ source_type: 'api_payment', source_id: 'order-1', country: 'CI', provider: null, operator: null, expected_amount: '5000', currency: 'XOF', created_at: '2026-07-24T00:00:00.000Z', sender_phone: '+2250102030405' }] });
    const result = await adminMobileMoneyQueueQuery.list({ page: 1, pageSize: 25, sourceType: 'api_payment' });
    expect(result.data[0]).toEqual(expect.objectContaining({ sourceType: 'api_payment', operatorMissing: true }));
    expect(JSON.stringify(result.data[0])).not.toContain('0102030405');
    expect(mocks.poolQuery.mock.calls[0][1]).toContain('api_payment');
  });

  it('accepts the same receipt idempotently and rejects a conflicting receipt', async () => {
    const existing = { id: 'receipt-1', provider: 'MTN', country: 'CI', operator: 'MTN', provider_reference: 'MM-1234', amount: 5000, currency: 'XOF', received_at: input.receivedAt, masked_sender: '***1234', evidence_hash: null, note: null };
    const client = { query: vi.fn().mockResolvedValue({ rows: [existing] }) };
    await expect(persistMobileMoneyReceipt(client, 'recharge', 'recharge-1', 'admin-1', input)).resolves.toEqual({ id: 'receipt-1', existing: true });
    await expect(persistMobileMoneyReceipt(client, 'recharge', 'recharge-1', 'admin-1', { ...input, providerReference: 'other' }))
      .rejects.toThrow('different receipt');
  });

  it('rejects API payments outside awaiting_mobile_money before writing a receipt', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM konektag.api_payment_orders')) return { rows: [{ id: '00000000-0000-4000-8000-000000000001', environment: 'live', state: 'pending', payment_method: 'mobile_money', external_amount: 5000, currency: 'XOF', country: 'CI' }] };
      return { rows: [] };
    });
    await expect(confirmApiPaymentMobileMoney('00000000-0000-4000-8000-000000000001', 'admin-1', input)).rejects.toThrow('not awaiting');
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO konektag.mobile_money_receipts'))).toBe(false);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('returns forbidden for an unauthenticated list request', async () => {
    const route = await import('../../src/api/routes/admin/mobile-money-queue.ts');
    const response = await route.GET({ locals: {}, request: new Request('http://localhost/api/admin/mobile-money-queue') } as any);
    expect(response.status).toBe(403);
  });

  it('returns forbidden for a non-admin user', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ role: 'user' }] });
    const route = await import('../../src/api/routes/admin/mobile-money-queue.ts');
    const response = await route.GET({ locals: { user: { id: 'user-1' } }, request: new Request('http://localhost/api/admin/mobile-money-queue') } as any);
    expect(response.status).toBe(403);
  });
});
