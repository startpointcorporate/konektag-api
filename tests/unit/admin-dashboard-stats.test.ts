import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

vi.mock('../../src/application/outbox-dispatcher.ts', () => {
  const metrics = {
    retryCount: 3, deadLetterCount: 1, blockedCount: 2,
    meanProjectionTime: 45, maxProjectionTime: 120,
    projectionFailuresPerMinute: 0,
    pendingCount: 0, oldestPendingAge: 0,
    blockedPerReason: {}, deadLettersPerReason: {},
    externalCallFailures: 0, erpnextLatency: 0, providerLatency: 0,
    _recentDurations: [], _failureTimestamps: [], _sampleIndex: 0,
  };
  return {
    getOutboxMetrics: () => ({ ...metrics }),
    startOutboxDispatcher: vi.fn(),
  };
});

let handler: any;

beforeEach(async () => {
  vi.resetAllMocks();
  const mod = await import('../../src/api/routes/admin/dashboard/stats.ts');
  handler = mod.GET;
});

const mockContext = (overrides = {}) => ({
  locals: { user: { id: 'admin-1' } },
  request: new Request('http://localhost/api/admin/dashboard/stats'),
  ...overrides,
});

describe('GET /api/admin/dashboard/stats', () => {
  it('returns 403 without admin role', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ role: 'user' }] });

    const res = await handler(mockContext());
    expect(res.status).toBe(403);
  });

  it('returns all KPIs and metrics for admin', async () => {
    mockPool.query
      // admin guard
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      // volume KPIs
      .mockResolvedValueOnce({ rows: [{
        total_recharges: 150, total_volume: 750000,
        pending_count: 12, confirmed_count: 130,
        reversed_count: 5, failed_count: 3,
        anomaly_count: 2, missing_credit_count: 1,
      }]})
      // by method
      .mockResolvedValueOnce({ rows: [
        { payment_method: 'mobile_money', count: 80, volume: 400000 },
        { payment_method: 'card', count: 50, volume: 250000 },
        { payment_method: 'crypto', count: 20, volume: 100000 },
      ]})
      // today
      .mockResolvedValueOnce({ rows: [{ today_count: 5, today_volume: 25000, today_confirmed: 3 }] })
      // outbox stats
      .mockResolvedValueOnce({ rows: [{
        pending_events: 8, blocked_events: 2,
        dead_lettered_count: 1, oldest_pending_age_seconds: 3600,
      }]})
      // dead letters
      .mockResolvedValueOnce({ rows: [{ unresolved_dead_letters: 1 }] })
      // reconciliation
      .mockResolvedValueOnce({ rows: [{ reconciliation_required: 2 }] })
      // integrations
      .mockResolvedValueOnce({ rows: [{ total_failed: 3, failed_count: 1, reconciliation_count: 2 }] })
      // recent events
      .mockResolvedValueOnce({ rows: [
        { event_type: 'RechargeConfirmed', aggregate_ref: 'KTG-RECH-001', created_at: '2026-07-19T12:00:00Z', reason: null },
        { event_type: 'RechargeCreated', aggregate_ref: 'KTG-RECH-002', created_at: '2026-07-19T11:00:00Z', reason: null },
      ]});

    const res = await handler(mockContext());
    expect(res.status).toBe(200);

    const data = JSON.parse(await res.text());

    // KPIs
    expect(data.kpis.totalRecharges).toBe(150);
    expect(data.kpis.totalVolume).toBe(750000);
    expect(data.kpis.pendingCount).toBe(12);
    expect(data.kpis.confirmedCount).toBe(130);
    expect(data.kpis.anomalyCount).toBe(2);

    // By method
    expect(data.byMethod).toHaveLength(3);
    expect(data.byMethod[0].method).toBe('mobile_money');

    // Today
    expect(data.today.count).toBe(5);
    expect(data.today.confirmed).toBe(3);

    // Queues
    expect(data.queues.pendingEvents).toBe(8);
    expect(data.queues.blockedEvents).toBe(2);

    // Dead letters
    expect(data.deadLetters.unresolved).toBe(1);

    // Reconciliation
    expect(data.reconciliation.required).toBe(2);

    // Integrations
    expect(data.integrations.totalFailed).toBe(3);

    // Outbox metrics
    expect(data.outboxMetrics.retryCount).toBe(3);
    expect(data.outboxMetrics.meanProjectionTime).toBe(45);

    // Recent events
    expect(data.recentEvents).toHaveLength(2);
    expect(data.recentEvents[0].type).toBe('RechargeConfirmed');
  });

  it('returns zeroes when no data exists', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ total_recharges: 0, total_volume: 0, pending_count: 0, confirmed_count: 0, reversed_count: 0, failed_count: 0, anomaly_count: 0, missing_credit_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ today_count: 0, today_volume: 0, today_confirmed: 0 }] })
      .mockResolvedValueOnce({ rows: [{ pending_events: 0, blocked_events: 0, dead_lettered_count: 0, oldest_pending_age_seconds: null }] })
      .mockResolvedValueOnce({ rows: [{ unresolved_dead_letters: 0 }] })
      .mockResolvedValueOnce({ rows: [{ reconciliation_required: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total_failed: 0, failed_count: 0, reconciliation_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await handler(mockContext());
    expect(res.status).toBe(200);
    const data = JSON.parse(await res.text());
    expect(data.kpis.totalRecharges).toBe(0);
    expect(data.queues.pendingEvents).toBe(0);
    expect(data.recentEvents).toEqual([]);
  });
});
