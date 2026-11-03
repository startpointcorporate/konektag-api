import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query, connect: vi.fn(async () => ({ query: m.clientQuery, release: m.release })) } }));

import { loyaltyService } from '../../src/application/services/loyalty-service.ts';

beforeEach(() => vi.clearAllMocks());

describe('PRO-06 loyalty attribution idempotency', () => {
  it('credits one stable reference in the same transaction as its ledger row', async () => {
    m.query
      .mockResolvedValueOnce({ rows: [{ value: { referral: 50 } }] })
      .mockResolvedValueOnce({ rows: [{ value: { bronze: 0, silver: 500, gold: 2000, platinum: 5000 } }] });
    m.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'ledger-1' }] })
      .mockResolvedValueOnce({ rows: [{ points: 10 }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await loyaltyService.earnPoints('user-1', 'referral', undefined, 'referral-reward:redemption-1');
    expect(m.clientQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO konektag.loyalty_transactions'), [
      'user-1', 50, 'referral', 'referral-reward:redemption-1',
    ]);
    expect(m.clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does not update the balance when the same reference was already credited', async () => {
    m.query.mockResolvedValueOnce({ rows: [{ value: { referral: 50 } }] });
    m.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});
    await loyaltyService.earnPoints('user-1', 'referral', undefined, 'referral-reward:redemption-1');
    expect(m.clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE konektag.loyalty_points'), expect.anything());
    expect(m.clientQuery).toHaveBeenCalledWith('COMMIT');
  });
});
