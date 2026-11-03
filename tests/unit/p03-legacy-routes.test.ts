import { describe, expect, it } from 'vitest';
import { POST as legacyRecharge } from '../../src/api/routes/admin/recharges/[id]/confirm-mobile-money.ts';
import { POST as legacyQueue } from '../../src/api/routes/admin/mobile-money-queue/recharges/[id]/confirm.ts';

describe('P03 legacy Mobile Money routes', () => {
  it('rejects browser confirmation callbacks without dispatching a credit', async () => {
    for (const handler of [legacyRecharge, legacyQueue]) {
      const response = await handler({} as any);
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ error: 'LEGACY_MOBILE_MONEY_CONFIRMATION_RETIRED' });
    }
  });
});
