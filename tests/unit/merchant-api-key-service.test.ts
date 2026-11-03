import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.poolQuery },
}));

import { merchantApiKeyService } from '../../src/application/services/merchant-api-key-service.ts';

describe('merchantApiKeyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [] });
  });

  it('replaces an existing environment key through the unique constraint', async () => {
    const result = await merchantApiKeyService.createKey('merchant-1', 'sandbox');

    expect(result.secretKey).toMatch(/^sk_test_[A-Za-z0-9_-]+$/);
    expect(result.publicKey).toMatch(/^pk_test_[A-Za-z0-9_-]+$/);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.poolQuery.mock.calls[0][0]).toContain('ON CONFLICT (merchant_profile_id, environment) DO UPDATE');
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual([
      'merchant-1',
      result.publicKey,
      expect.any(String),
      'sandbox',
    ]);
  });
});
