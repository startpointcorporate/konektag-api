import { expect, it } from 'vitest';
import { POST } from '../../src/api/routes/admin/merchant-settlements/[id]/confirm.ts';

it('retires the legacy settlement confirmation mutation', async () => {
  const response = await POST({} as any);
  expect(response.status).toBe(410);
  await expect(response.json()).resolves.toEqual({
    error: 'LEGACY_SETTLEMENT_CONFIRMATION_RETIRED',
    confirmRoute: '/api/admin/merchant-settlements/confirm',
  });
});
