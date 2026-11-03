import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockComputeReadiness = vi.fn();
vi.mock('../../src/application/services/operational-health-service.ts', () => ({
  computeOperationalReadiness: mockComputeReadiness,
}));

const VALID_SHA = '0fab507e5511e297e0a225cb284727cfb47f4780';
const savedEnv = { ...process.env };

let GET: any;

const readyResult = {
  ready: true,
  reasonCode: 'AGGREGATE_READY',
  version: VALID_SHA,
  processes: [
    {
      processId: 'accounting-worker', healthy: true, reasonCode: 'PROCESS_HEALTHY',
      appVersion: VALID_SHA, lastStartedAt: '2026-07-29T11:00:00.000Z',
      lastHeartbeatAt: '2026-07-29T11:59:50.000Z', lastSuccessAt: null,
      lastFailureAt: null, failureCode: null,
    },
  ],
};

const notReadyResult = {
  ready: false,
  reasonCode: 'AGGREGATE_PROCESS_UNHEALTHY',
  version: VALID_SHA,
  processes: [
    {
      processId: 'reconciliation-cron', healthy: false, reasonCode: 'PROCESS_EXECUTION_STALE',
      appVersion: VALID_SHA, lastStartedAt: '2026-07-27T02:00:00.000Z',
      lastHeartbeatAt: null, lastSuccessAt: '2026-07-27T02:05:00.000Z',
      lastFailureAt: null, failureCode: null,
    },
  ],
};

function context(headers: Record<string, string> = {}) {
  return { request: new Request('http://internal/api/internal/operational-readiness', { headers }) };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env = { ...savedEnv, INTERNAL_API_TOKEN: 'test-internal-token' };
  const mod = await import('../../src/api/routes/internal/operational-readiness.ts');
  GET = mod.GET;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('GET /api/internal/operational-readiness — authorization', () => {
  it('rejects anonymous access', async () => {
    const res = await GET(context());
    expect(res.status).toBe(401);
    expect(mockComputeReadiness).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', async () => {
    const res = await GET(context({ Authorization: 'Bearer wrong-token' }));
    expect(res.status).toBe(401);
    expect(mockComputeReadiness).not.toHaveBeenCalled();
  });

  it('rejects all access when the internal token is not configured', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const res = await GET(context({ Authorization: 'Bearer test-internal-token' }));
    expect(res.status).toBe(401);
    expect(mockComputeReadiness).not.toHaveBeenCalled();
  });

  it('returns 200 with sanitized evidence when ready and authorized', async () => {
    mockComputeReadiness.mockResolvedValue(readyResult);
    const res = await GET(context({ Authorization: 'Bearer test-internal-token' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.version).toBe(VALID_SHA);
    expect(body.processes[0].processId).toBe('accounting-worker');
    expect(body.timestamp).toBeTruthy();
  });

  it('returns 503 with sanitized failure evidence when not ready', async () => {
    mockComputeReadiness.mockResolvedValue(notReadyResult);
    const res = await GET(context({ Authorization: 'Bearer test-internal-token' }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.processes[0].reasonCode).toBe('PROCESS_EXECUTION_STALE');
  });

  it('never exposes secrets, connection strings, tokens or personal data', async () => {
    mockComputeReadiness.mockResolvedValue(notReadyResult);
    const res = await GET(context({ Authorization: 'Bearer test-internal-token' }));
    const serialized = JSON.stringify(await res.json());

    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('test-internal-token');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(serialized).not.toContain('at Object.');
  });
});
