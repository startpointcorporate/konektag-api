import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), requireEntitlement: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/merchant-service.ts', () => ({ merchantService: { getProfile: vi.fn() } }));
vi.mock('../../src/application/services/entitlement-decision-service.ts', () => ({ requireEntitlement: m.requireEntitlement }));

import { createDestination, recordEvent, resolveDestination } from '../../src/application/growth-service.ts';

const destination = {
  id: '11111111-1111-4111-8111-111111111111',
  merchant_profile_id: '22222222-2222-4222-8222-222222222222',
  target_type: 'promotion',
  target_id: '33333333-3333-4333-8333-333333333333',
  target_ref: null,
  channel: 'smart_qr',
  attribution_id: '44444444-4444-4444-8444-444444444444',
  is_active: true,
  expires_at: null,
  slug: 'merchant',
  merchant_status: 'Published',
  merchant_deleted_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireEntitlement.mockResolvedValue(undefined);
});

describe('PRO-06 growth destinations and attribution', () => {
  it('rejects an attribution from another destination before resolving the target', async () => {
    m.query.mockResolvedValueOnce({ rows: [{ ...destination }] });
    await expect(resolveDestination(destination.id, '55555555-5555-4555-8555-555555555555')).rejects.toThrow('DESTINATION_NOT_FOUND');
    expect(m.query).toHaveBeenCalledOnce();
  });

  it('rejects expired or inactive destinations returned by the server query', async () => {
    m.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveDestination(destination.id, destination.attribution_id)).rejects.toThrow('DESTINATION_NOT_FOUND');
  });

  it('rejects obsolete promotion QR creation while retaining historical event reads', async () => {
    await expect(createDestination({actorId:'actor',merchantId:destination.merchant_profile_id,targetType:'promotion',targetId:destination.target_id})).rejects.toThrow('INVALID_TARGET_TYPE');
    expect(m.query).not.toHaveBeenCalled();
  });

  it('accepts the first event and ignores an exact replay for the same merchant key', async () => {
    m.query
      .mockResolvedValueOnce({ rows: [{ ...destination }] })
      .mockResolvedValueOnce({ rows: [{ id: destination.target_id }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [{ ...destination }] })
      .mockResolvedValueOnce({ rows: [{ id: destination.target_id }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const input = { destinationId: destination.id, attributionId: destination.attribution_id, eventType: 'promotion_clicked' as const, eventKey: 'stable-click' };
    await expect(recordEvent(input)).resolves.toMatchObject({ accepted: true, merchantId: destination.merchant_profile_id });
    await expect(recordEvent(input)).resolves.toMatchObject({ accepted: false, eventKey: 'stable-click' });
    expect(m.query.mock.calls.filter(([sql]) => String(sql).includes('ON CONFLICT (merchant_profile_id, event_key)')).length).toBe(2);
  });
});
