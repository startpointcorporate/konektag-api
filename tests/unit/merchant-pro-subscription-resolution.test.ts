import { describe, it, expect, vi } from 'vitest';
import { MerchantProSubscriptionService } from '../../src/application/services/merchant-pro-subscription-service.ts';
const at = new Date('2026-09-15T12:00:00Z');
const active = { id: 'one', merchant_profile_id: 'shop', subscription_type: 'MONTHLY', subscription_start: new Date('2026-01-01Z'), subscription_end: null, status: 'ACTIVE', created_at: at };
function fixture(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, service: new MerchantProSubscriptionService({ query } as any) };
}
describe('subscription resolver', () => {
  it.each([
    ['ABSENT', []], ['ACTIVE', [active]],
    ['SCHEDULED', [{ ...active, subscription_start: new Date('2027-01-01Z') }]],
    ['EXPIRED', [{ ...active, subscription_end: at }]],
    ['EXPIRED', [{ ...active, subscription_end: new Date('2026-02-01Z') }]],
    ['INACTIVE', [{ ...active, status: 'INACTIVE' }]],
    ['CANCELLED', [{ ...active, status: 'CANCELLED' }]],
    ['INACTIVE', [{ ...active, status: 'Enterprise' }]],
    ['INACTIVE', [{ ...active, subscription_type: 'Enterprise' }]],
  ])('resolves %s', async (state, rows) => {
    const { service, query } = fixture(rows as unknown[]);
    expect((await service.resolveSubscription('shop', at)).state).toBe(state);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('konektag.merchant_pro_subscriptions'), ['shop']);
  });
  it('does not let a later inactive or scheduled row mask an active subscription', async () => {
    const { service } = fixture([{ ...active, id: 'latest', status: 'INACTIVE' }, { ...active, id: 'future', subscription_start: new Date('2027-01-01Z') }, active]);
    expect((await service.getActiveSubscription('shop', at))?.id).toBe('one');
  });
  it('enforces deterministic SQL ordering and one-commerce scope', async () => {
    const { service, query } = fixture([]); await service.getActiveSubscription('shop', at);
    expect(query.mock.calls[0][0]).toContain('ORDER BY subscription_start DESC, created_at DESC, id DESC');
    expect(query.mock.calls[0][0]).toContain('WHERE merchant_profile_id = $1');
  });
  it('keeps the annual formula and its one-month cutoff', async () => {
    const { service } = fixture([]);
    expect(await service.calculateAnnualPrice(6, 8900)).toBe(50730);
    expect((await service.calculateProratedAnnualPrice(new Date(2026,11,1),8900)).available).toBe(false);
    expect((await service.calculateProratedAnnualPrice(new Date(2026,10,1),8900)).amount).toBe(16910);
  });
  it('rejects runtime Enterprise subscription creation before any DB call', async () => {
    const { service, query } = fixture([]);
    await expect(service.createSubscription({ merchant_profile_id: 'shop', subscription_type: 'Enterprise', subscription_start: at, subscription_end: null } as any)).rejects.toThrow('INVALID_SUBSCRIPTION');
    expect(query).not.toHaveBeenCalled();
  });
});
