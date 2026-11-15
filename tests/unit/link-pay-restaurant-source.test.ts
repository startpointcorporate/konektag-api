import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../src/application/marketplace-transactions/frappe-site.ts', async original => ({
  ...await original<any>(), frappeSite: () => ({ call: mocks.call }),
}));
import { verifyRestaurantSource, claimRestaurantSource } from '../../src/application/link-pay/restaurant-source.ts';
const source = { attempt: '11111111-1111-4111-8111-111111111111', posProfile: 'Restaurant', fingerprint: 'a'.repeat(64) };
const snapshot = { ...source, order: 'ORD-1', company: 'Merchant', currency: 'XAF', amountMajor: '1200',
  expiresAt: '2026-11-16T10:00:00+01:00', state: 'Prepared' };
beforeEach(() => vi.resetAllMocks());
it('derives the amount and order only from the scoped native attempt', async () => {
  mocks.call.mockResolvedValue(snapshot);
  expect(await verifyRestaurantSource('RESTODEMO', source.attempt, source.posProfile)).toMatchObject({
    invoice: { name: 'ORD-1', amountMajor: '1200', currency: 'XAF' }, source,
  });
  expect(mocks.call).toHaveBeenCalledWith('konektag_360.link_pay.pos.verify_attempt', {
    attempt: source.attempt, pos_profile: source.posProfile,
  });
});
it('does not pay an attempt returned for another POS or with changed frozen contents', async () => {
  mocks.call.mockResolvedValue({ ...snapshot, posProfile: 'Other' });
  await expect(verifyRestaurantSource('RESTODEMO', source.attempt, source.posProfile)).rejects.toMatchObject({ code: 'SOURCE_CONTRACT_INVALID' });
  mocks.call.mockResolvedValue({ ...snapshot, state: 'Claimed', fingerprint: 'b'.repeat(64) });
  await expect(claimRestaurantSource('RESTODEMO', source, 'link1')).rejects.toMatchObject({ code: 'SOURCE_NOT_COLLECTABLE' });
});
it('refuses a cancelled attempt but accepts an idempotent native claim', async () => {
  mocks.call.mockResolvedValue({ ...snapshot, state: 'Cancelled' });
  await expect(verifyRestaurantSource('RESTODEMO', source.attempt, source.posProfile)).rejects.toMatchObject({ code: 'SOURCE_NOT_COLLECTABLE' });
  mocks.call.mockResolvedValue({ ...snapshot, state: 'Claimed' });
  expect((await claimRestaurantSource('RESTODEMO', source, 'link1')).state).toBe('Claimed');
});
