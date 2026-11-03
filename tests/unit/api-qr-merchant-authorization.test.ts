import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOwnerOrManager: vi.fn(),
  listMerchantPayments: vi.fn(),
  listClientPayments: vi.fn(),
}));

vi.mock('../../src/application/merchant-service.ts', () => ({
  merchantService: { requireOwnerOrManager: mocks.requireOwnerOrManager },
}));
vi.mock('../../src/application/services/qr-service.ts', () => ({
  qrService: {
    listMerchantPayments: mocks.listMerchantPayments,
    listClientPayments: mocks.listClientPayments,
  },
  QRValidationError: class QRValidationError extends Error {},
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));

import { GET } from '../../src/api/routes/qr/index.ts';
import { MerchantNotOwnerError } from '../../src/domain/MerchantErrors.ts';

describe('GET /api/qr?type=merchant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not list an arbitrary merchant profile without exact owner/manager authorization', async () => {
    mocks.requireOwnerOrManager.mockRejectedValue(new MerchantNotOwnerError());
    const response = await GET({
      url: new URL('https://konektag.test/api/qr?type=merchant&merchantProfileId=merchant-2'),
      locals: { user: { id: 'actor-1' } },
    } as any);

    expect(response.status).toBe(403);
    expect(mocks.requireOwnerOrManager).toHaveBeenCalledWith('merchant-2', 'actor-1');
    expect(mocks.listMerchantPayments).not.toHaveBeenCalled();
  });

  it('preserves client payment listing', async () => {
    mocks.listClientPayments.mockResolvedValue([{ id: 'payment-1' }]);
    const response = await GET({
      url: new URL('https://konektag.test/api/qr?type=client'),
      locals: { user: { id: 'actor-1' } },
    } as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: 'payment-1' }]);
    expect(mocks.requireOwnerOrManager).not.toHaveBeenCalled();
  });
});
