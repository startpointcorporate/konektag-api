import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({
  getCorrelationId: () => 'corr-test-outbox',
}));

import { rechargeService } from '../../src/application/services/recharge-service.ts';

describe('RechargeService PostgreSQL command emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  it('creates the recharge through a RechargeCreated command event', async () => {
    const { doc, projectionStatus } = await rechargeService.createRecharge({
      keycloakId: 'kc-1', clientEmail: 'test@test.com', amount: 5000, currency: 'xof',
      paymentMethod: 'Mobile Money', country: 'CI', operator: 'MTN', phoneNumber: '+2250102030405',
    });

    expect(doc).toMatchObject({
      name: expect.stringMatching(/^KTG-RECH-/), keycloak_id: 'kc-1', amount: 5000,
      currency: 'XOF', payment_method: 'Mobile Money', status: 'Pending',
    });
    expect(projectionStatus).toBe('accepted');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][0]).toContain('INSERT INTO konektag.outbox_events');
    expect(mockPool.query.mock.calls[0][0]).toContain("'RechargeCreated'");

    const payload = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(payload).toMatchObject({
      rechargeName: doc.name, keycloakId: 'kc-1', requestedAmount: 5000,
      requestedCurrency: 'XOF', paymentMethod: 'mobile_money', paymentProvider: 'MTN',
      mobileMoneyPhone: '+2250102030405',
    });
  });

  it('maps crypto details into the existing projection contract', async () => {
    const { doc } = await rechargeService.createRecharge({
      keycloakId: 'kc-2', clientEmail: 'crypto@test.com', amount: 50, currency: 'EUR',
      paymentMethod: 'Crypto', country: 'FR', cryptoNetwork: 'USDT (TRC20)', cryptoAddress: 'TXYZ123456',
    });

    const payload = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(payload).toMatchObject({
      rechargeName: doc.name, paymentMethod: 'crypto', cryptoNetwork: 'USDT (TRC20)',
      cryptoAddress: 'TXYZ123456', providerReference: 'TXYZ123456',
    });
  });

  it('maps Stripe-compatible methods to the card projection contract', async () => {
    await rechargeService.createRecharge({
      keycloakId: 'kc-3', clientEmail: 'card@test.com', amount: 25, currency: 'EUR',
      paymentMethod: 'Stripe', country: 'FR', status: 'Pending',
    });

    const payload = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(payload).toMatchObject({ paymentMethod: 'card', paymentProvider: 'STRIPE' });
  });
});
