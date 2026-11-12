import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/application/services/pay/points-wallet-service.ts', () => ({
  resolvePointsOwner: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
}));

import { confirmPointsAcquisition } from '../../src/application/services/pay/points-acquisition-service.ts';

describe('confirmPointsAcquisition', () => {
  it.each([['EUR', 1200, 12], ['USD', 1221, 12.21], ['XAF', 8567, 8567]])(
    'keeps the %s economic value in major currency units', async (currency, lotValueMinor, economicValue) => {
      const query = vi.fn(async (sql: string) => ({ rows: sql.includes('INSERT INTO konektag.points_acquisitions') ? [{ id: 'acq' }] : [] }));
      await confirmPointsAcquisition({ query } as any, {
        orderId: 'order', userId: 'user', provider: 'pawapay', providerReference: 'deposit', providerEventId: 'event',
        attemptId: 'attempt', confirmedMinor: lotValueMinor, currency, pointsQuantity: 12, lotValueMinor,
        legalEntityId: 'entity', corridorId: 'CG-CG', regulatoryProfileId: 'profile',
      });
      const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO konektag.klots')) as unknown as [string, unknown[]];
      expect(insert[1][7]).toBe(economicValue);
    });
  it('mints purchased K quantity, excluding PSP fees and tax', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: any = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id,transaction_id,status FROM konektag.points_acquisitions')) return { rows: [] };
        if (sql.includes('INSERT INTO konektag.points_acquisitions')) return { rows: [{ id: 'acq-id' }] };
        return { rows: [] };
      }),
    };

    await confirmPointsAcquisition(db, {
      orderId: 'order-id',
      userId: 'user-id',
      provider: 'stripe',
      providerReference: 'pi_test',
      providerEventId: 'event-id',
      attemptId: 'attempt-id',
      confirmedMinor: 6200,
      currency: 'EUR',
      pointsQuantity: 50,
      lotValueMinor: 5000,
      legalEntityId: 'entity-id',
      corridorId: 'FR-FR',
      regulatoryProfileId: 'profile-id',
    });

    const legs = calls.filter(call => call.sql.includes('INSERT INTO konektag.ledger_entries'));
    expect(legs).toHaveLength(4);
    expect(legs.every(call => call.params[4] === 50)).toBe(true);
    expect(calls.some(call => call.sql.includes('points_payment_confirmations') && call.params.includes(6200))).toBe(true);
    expect(calls.some(call => call.sql.includes('points_lots') && call.params.includes(5000) && call.params.includes(50))).toBe(true);
  });

  it('returns the existing transaction on completed replay', async () => {
    const db: any = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id,transaction_id,status FROM konektag.points_acquisitions')) {
          return { rows: [{ id: 'acq-id', transaction_id: 'tx-existing', status: 'completed' }] };
        }
        return { rows: [] };
      }),
    };

    const result = await confirmPointsAcquisition(db, {
      orderId: 'order-id',
      userId: 'user-id',
      provider: 'stripe',
      providerReference: 'pi_test',
      providerEventId: 'event-id',
      attemptId: 'attempt-id',
      confirmedMinor: 6200,
      currency: 'EUR',
      pointsQuantity: 50,
      lotValueMinor: 5000,
      legalEntityId: 'entity-id',
      corridorId: 'FR-FR',
      regulatoryProfileId: 'profile-id',
    });

    expect(result.transactionId).toBe('tx-existing');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
