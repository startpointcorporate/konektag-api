import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStripeRefund, mockDebit } = vi.hoisted(() => ({
  mockStripeRefund: vi.fn().mockResolvedValue({ id: 're_abc123', status: 'succeeded' }),
  mockDebit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    refunds = { create: mockStripeRefund };
    constructor(_key: string) {}
  },
}));

vi.mock('../../src/application/services/ledger-service.ts', () => ({
  ledgerService: { debit: mockDebit },
}));

const { mockClient } = vi.hoisted(() => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  return { mockClient: client };
});

vi.mock('../../src/infrastructure/database/pool.ts', () => {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() };
  pool.connect.mockResolvedValue(mockClient);
  return { default: pool };
});

vi.mock('../../src/application/services/resend-service.ts', () => ({
  emailService: { sendTemplate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/infrastructure/correlation-id.ts', () => ({
  getCorrelationId: () => 'corr-test-refund',
}));

vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({
  encryptionService: { decrypt: () => JSON.stringify({ email: 'test@test.com', firstName: 'Test' }) },
}));

import { refundStripeRecharge } from '../../src/application/commands/admin/refund-stripe-command.ts';
import pool from '../../src/infrastructure/database/pool.ts';

describe('refundStripeRecharge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses debit for reversal', async () => {
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ recharge_name: 'REC-1', keycloak_id: 'kc-1', requested_amount: 2500, requested_currency: 'EUR', recharge_status: 'confirmed', credited_amount: 2500, payment_method: 'card', payment_provider: 'Stripe', stripe_payment_intent: 'pi_1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await refundStripeRecharge({ rechargeName: 'REC-1', adminId: 'admin-1', reason: 'Customer request' });

    expect(mockStripeRefund).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_1' }),
    );
    expect(mockDebit).toHaveBeenCalled();
  });

  it('is idempotent — returns success when already reversed', async () => {
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [{ recharge_name: 'REC-1', keycloak_id: 'kc-1', requested_amount: 2500, recharge_status: 'confirmed', credited_amount: 2500, payment_method: 'card', stripe_payment_intent: 'pi_1' }] })
      .mockResolvedValueOnce({ rows: [{ payload: JSON.stringify({ stripeRefundId: 're_existing' }) }] });

    const result = await refundStripeRecharge({ rechargeName: 'REC-1', adminId: 'admin-1', reason: 'Test' });

    expect(result.success).toBe(true);
    expect(result.stripeRefundId).toBe('re_existing');
    expect(mockStripeRefund).not.toHaveBeenCalled();
  });
});
