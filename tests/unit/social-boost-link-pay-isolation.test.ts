import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query },
}));

import { markSocialBoostPaid } from '../../src/application/services/merchant-social-boost-service.ts';

describe('social boost Link Pay isolation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('records the paid transition and event only in PostgreSQL', async () => {
    const boost = { id: 'boost-1', paid_at: '2026-11-09T15:00:00.000Z' };
    mocks.query
      .mockResolvedValueOnce({ rows: [boost] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(markSocialBoostPaid('boost-payment-reference')).resolves.toBe(boost);

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[0][0])).toContain('merchant_social_boosts');
    expect(String(mocks.query.mock.calls[1][0])).toContain('merchant_social_boost_events');
    expect(mocks.query.mock.calls.flat().join(' ')).not.toMatch(/erpnext|sales invoice|erp-sync/i);
  });
});
