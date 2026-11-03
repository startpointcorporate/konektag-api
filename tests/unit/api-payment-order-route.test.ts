import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), validateApiKey: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query },
}));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: {} }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: {} }));
vi.mock('../../src/application/services/pay/api-payment-webhook-service.ts', () => ({ apiPaymentWebhookService: {} }));
vi.mock('../../src/application/services/pay/wallet-debit-authorization-service.ts', () => ({ walletDebitAuthorizationService: {} }));
vi.mock('../../src/application/services/activation-challenge-service.ts', () => ({ activationChallengeService: {} }));
vi.mock('../../src/application/services/merchant-api-key-service.ts', () => ({
  merchantApiKeyService: { validateApiKey: mocks.validateApiKey },
}));

import { GET } from '../../src/api/routes/pay/payments/[id].ts';

describe('API payment order route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the modern PostgreSQL order and preserves the order envelope', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'order-1', merchant_profile_id: 'merchant-1', environment: 'live',
      merchant_transaction_id: 'tx-1', label: 'Invoice', payer_identity: 'payer', currency: 'XOF',
      subtotal_amount: 1000, tax_amount: 0, fee_amount: 30, cashback_amount: 0, total_amount: 1030,
      state: 'paid', payment_method: 'card', paid_at: '2026-08-04T10:00:00.000Z',
      merchant_name: 'Merchant', merchant_logo_url: null,
    }] });

    const response = await GET({ params: { id: 'order-1' },
      request: new Request('http://localhost/api/pay/payments/order-1'),
      locals: { user: { id: 'user-1' } } } as any);

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('merchant_memberships'), ['order-1', null, 'user-1']);
    expect(await response.json()).toEqual({ order: expect.objectContaining({
      id: 'order-1', merchantTransactionId: 'tx-1', totalAmount: 1030, state: 'paid',
    }) });
  });

  it('preserves the 404 error contract for an unknown order', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await GET({ params: { id: 'missing' },
      request: new Request('http://localhost/api/pay/payments/missing'),
      locals: { user: { id: 'user-1' } } } as any);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Payment order not found' });
  });

  it('requires an authenticated merchant principal', async () => {
    const response = await GET({ params: { id: 'order-1' },
      request: new Request('http://localhost/api/pay/payments/order-1'), locals: {} } as any);
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('scopes API-key reads to the owning merchant', async () => {
    mocks.validateApiKey.mockResolvedValue({ merchantProfileId: 'merchant-1' });
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await GET({ params: { id: 'order-2' }, request: new Request(
      'http://localhost/api/pay/payments/order-2', { headers: { authorization: 'Bearer sk_live_owner' } }), locals: {} } as any);
    expect(response.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), ['order-2', 'merchant-1', null]);
  });
});
