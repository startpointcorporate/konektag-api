import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  convert: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query, connect: mocks.connect },
}));

vi.mock('../../src/application/services/exchange-rate-service.ts', () => ({
  exchangeRateService: { convert: mocks.convert },
}));

import { ActivationChallengeError, activationChallengeService } from '../../src/application/services/activation-challenge-service.ts';

describe('activationChallengeService.recordActivity', () => {
  const activity = {
    userId: 'user-1',
    sourceType: 'k_send' as const,
    sourceId: 'TRF-1',
    metricType: 'KSend' as const,
    amount: 200,
    currency: 'EUR',
  };

  it('rejects a non-positive source amount before querying the database', async () => {
    await expect(activationChallengeService.recordActivity({ ...activity, amount: 0 }))
      .rejects.toBeInstanceOf(ActivationChallengeError);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid ISO currency before converting or querying', async () => {
    await expect(activationChallengeService.recordActivity({ ...activity, currency: 'EURO' }))
      .rejects.toBeInstanceOf(ActivationChallengeError);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it('refuses an activity when no EUR conversion rate can be snapshotted', async () => {
    mocks.convert.mockResolvedValueOnce(null);
    await expect(activationChallengeService.recordActivity(activity))
      .rejects.toThrow('No EUR conversion is available for EUR');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
