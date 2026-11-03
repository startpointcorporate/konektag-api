import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

const VALID_SHA = '0fab507e5511e297e0a225cb284727cfb47f4780';
const OTHER_SHA = 'd18fa00502dfa9d81911fba30b7b06f91f420a07';
const NOW = new Date('2026-07-29T12:00:00.000Z');

const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

let health: any;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  health = await import('../../src/application/services/operational-health-service.ts');
});

const expectedValid = { version: VALID_SHA, valid: true, deploymentMode: true };
const expectedInvalid = { version: null, valid: false, deploymentMode: true };

const workerSpec = { processId: 'accounting-worker', executionType: 'worker', heartbeatFreshnessSeconds: 60 };
const cronSpec = {
  processId: 'reconciliation-cron', executionType: 'cron',
  cadenceSeconds: 86400, graceSeconds: 3600, maxRunDurationSeconds: 3600,
};

function run(overrides: any = {}) {
  return {
    status: 'RUNNING',
    app_version: VALID_SHA,
    failure_code: null,
    started_at: secondsAgo(120),
    heartbeat_at: secondsAgo(10),
    completed_at: null,
    ...overrides,
  };
}

describe('operational-health — long-running worker evaluation', () => {
  it('is healthy with recent running evidence and matching version', () => {
    const result = health.evaluateProcess(workerSpec, [run()], expectedValid, NOW);
    expect(result.healthy).toBe(true);
    expect(result.reasonCode).toBe('PROCESS_HEALTHY');
    expect(result.appVersion).toBe(VALID_SHA);
  });

  it('is unhealthy without evidence and never defaults to success', () => {
    const result = health.evaluateProcess(workerSpec, [], expectedValid, NOW);
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_NO_EVIDENCE');
  });

  it('is unhealthy when the heartbeat is stale', () => {
    const result = health.evaluateProcess(
      workerSpec,
      [run({ heartbeat_at: secondsAgo(300), started_at: secondsAgo(600) })],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_HEARTBEAT_STALE');
  });

  it('a newer failure supersedes an older success', () => {
    const result = health.evaluateProcess(
      workerSpec,
      [
        run({ status: 'FAILED', started_at: secondsAgo(30), completed_at: secondsAgo(25), failure_code: 'ERP_NEXT_UNAVAILABLE' }),
        run({ status: 'SUCCEEDED', started_at: secondsAgo(4000), completed_at: secondsAgo(3900) }),
      ],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_LAST_RUN_FAILED');
    expect(result.failureCode).toBe('ERP_NEXT_UNAVAILABLE');
  });

  it('is unhealthy when the immutable version is missing or mismatched', () => {
    expect(health.evaluateProcess(workerSpec, [run()], expectedInvalid, NOW).reasonCode)
      .toBe('PROCESS_VERSION_INVALID');
    expect(health.evaluateProcess(workerSpec, [run({ app_version: OTHER_SHA })], expectedValid, NOW).reasonCode)
      .toBe('PROCESS_VERSION_MISMATCH');
  });

  it('accepts a freshly started worker before its first heartbeat', () => {
    const result = health.evaluateProcess(
      workerSpec,
      [run({ status: 'STARTED', heartbeat_at: null, started_at: secondsAgo(5) })],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(true);
  });

  it('rejects unsupported evidence statuses fail-closed', () => {
    const result = health.evaluateProcess(
      workerSpec,
      [run({ status: 'UNKNOWN_THING' })],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_STATUS_UNSUPPORTED');
  });
});

describe('operational-health — scheduled control evaluation', () => {
  const succeeded = (completedS: number, overrides: any = {}) => run({
    status: 'SUCCEEDED',
    started_at: secondsAgo(completedS + 60),
    heartbeat_at: null,
    completed_at: secondsAgo(completedS),
    ...overrides,
  });

  it('is healthy after a recent terminal success', () => {
    const result = health.evaluateProcess(cronSpec, [succeeded(7200)], expectedValid, NOW);
    expect(result.healthy).toBe(true);
    expect(result.reasonCode).toBe('PROCESS_HEALTHY');
  });

  it('a newer terminal failure supersedes an older success', () => {
    const result = health.evaluateProcess(
      cronSpec,
      [
        run({ status: 'FAILED', started_at: secondsAgo(1200), completed_at: secondsAgo(1100), failure_code: 'RECONCILIATION_CONTEXT_MISSING' }),
        succeeded(7200),
      ],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_LAST_RUN_FAILED');
    expect(result.failureCode).toBe('RECONCILIATION_CONTEXT_MISSING');
  });

  it('is unhealthy when the latest success is older than cadence plus grace', () => {
    const result = health.evaluateProcess(cronSpec, [succeeded(86400 + 3600 + 60)], expectedValid, NOW);
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_EXECUTION_STALE');
  });

  it('an abandoned non-terminal run is unhealthy even with a fresh prior success', () => {
    const result = health.evaluateProcess(
      cronSpec,
      [
        run({ status: 'RUNNING', started_at: secondsAgo(7200), heartbeat_at: secondsAgo(7000) }),
        succeeded(8000),
      ],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe('PROCESS_RUN_ABANDONED');
  });

  it('a run in progress within its window does not fail a fresh prior success', () => {
    const result = health.evaluateProcess(
      cronSpec,
      [
        run({ status: 'STARTED', started_at: secondsAgo(300), heartbeat_at: null }),
        succeeded(7200),
      ],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(true);
  });

  it('a started execution without terminal evidence is never a success', () => {
    const result = health.evaluateProcess(
      cronSpec,
      [run({ status: 'RUNNING', started_at: secondsAgo(300) })],
      expectedValid,
      NOW,
    );
    expect(result.healthy).toBe(false);
  });
});

describe('operational-health — aggregate readiness', () => {
  const healthyProcess = (processId: string) => ({
    processId, healthy: true, reasonCode: 'PROCESS_HEALTHY', appVersion: VALID_SHA,
    lastStartedAt: null, lastHeartbeatAt: null, lastSuccessAt: null, lastFailureAt: null, failureCode: null,
  });
  const unhealthyProcess = (processId: string, reasonCode: string) => ({
    processId, healthy: false, reasonCode, appVersion: VALID_SHA,
    lastStartedAt: null, lastHeartbeatAt: null, lastSuccessAt: null, lastFailureAt: null, failureCode: null,
  });

  it('succeeds only when every mandatory process is healthy with the expected version', () => {
    const result = health.aggregateReadiness(
      health.MANDATORY_PROCESSES.map((s: any) => healthyProcess(s.processId)),
      expectedValid,
    );
    expect(result.ready).toBe(true);
    expect(result.reasonCode).toBe('AGGREGATE_READY');
    expect(result.version).toBe(VALID_SHA);
  });

  it('fails when any mandatory process is missing, stale, failed or mismatched', () => {
    for (const bad of [
      unhealthyProcess('accounting-worker', 'PROCESS_NO_EVIDENCE'),
      unhealthyProcess('reconciliation-cron', 'PROCESS_EXECUTION_STALE'),
      unhealthyProcess('sanctions-cron', 'PROCESS_LAST_RUN_FAILED'),
      unhealthyProcess('retention-cron', 'PROCESS_VERSION_MISMATCH'),
    ]) {
      const healths = health.MANDATORY_PROCESSES.map((s: any) =>
        s.processId === bad.processId ? bad : healthyProcess(s.processId));
      const result = health.aggregateReadiness(healths, expectedValid);
      expect(result.ready).toBe(false);
      expect(result.reasonCode).toBe('AGGREGATE_PROCESS_UNHEALTHY');
    }
  });

  it('fails when the deployment identity itself is missing or invalid', () => {
    const result = health.aggregateReadiness(
      health.MANDATORY_PROCESSES.map((s: any) => healthyProcess(s.processId)),
      expectedInvalid,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCode).toBe('AGGREGATE_VERSION_INVALID');
  });
});

describe('operational-health — evidence access failures fail closed', () => {
  const healthyWorkerRuns = () => [
    run({ status: 'RUNNING', heartbeat_at: secondsAgo(5) }),
  ];
  const healthyCronRuns = () => [
    run({ status: 'SUCCEEDED', started_at: secondsAgo(3700), completed_at: secondsAgo(3600), heartbeat_at: null }),
  ];

  function routeHealthyEvidence() {
    mockPool.query.mockImplementation(async (_sql: string, params: any[] = []) => {
      const processId = params[0];
      if (processId === 'outbox-dispatcher' || processId === 'accounting-worker') {
        return { rows: healthyWorkerRuns() };
      }
      return { rows: healthyCronRuns() };
    });
  }

  it('is ready when every mandatory process has fresh durable evidence', async () => {
    routeHealthyEvidence();
    const result = await health.computeOperationalReadiness(NOW, mockPool, expectedValid);
    expect(result.ready).toBe(true);
    expect(result.processes).toHaveLength(5);
    expect(result.processes.every((p: any) => p.healthy)).toBe(true);
  });

  it('fails when one mandatory process has no evidence', async () => {
    routeHealthyEvidence();
    const base = mockPool.query.getMockImplementation()!;
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (params[0] === 'retention-cron') return { rows: [] };
      return base(sql, params);
    });
    const result = await health.computeOperationalReadiness(NOW, mockPool, expectedValid);
    expect(result.ready).toBe(false);
    const retention = result.processes.find((p: any) => p.processId === 'retention-cron');
    expect(retention.reasonCode).toBe('PROCESS_NO_EVIDENCE');
  });

  it('fails closed when the evidence schema is missing (42P01)', async () => {
    mockPool.query.mockRejectedValue(Object.assign(new Error('relation "konektag.process_runs" does not exist'), { code: '42P01' }));
    const result = await health.computeOperationalReadiness(NOW, mockPool, expectedValid);
    expect(result.ready).toBe(false);
    expect(result.processes.every((p: any) => !p.healthy && p.reasonCode === 'PROCESS_SCHEMA_MISSING')).toBe(true);
  });

  it('fails closed when the evidence query is unavailable', async () => {
    mockPool.query.mockRejectedValue(new Error('connection terminated'));
    const result = await health.computeOperationalReadiness(NOW, mockPool, expectedValid);
    expect(result.ready).toBe(false);
    expect(result.processes.every((p: any) => !p.healthy && p.reasonCode === 'PROCESS_EVIDENCE_UNAVAILABLE')).toBe(true);
  });

  it('exposes only sanitized process identifiers and reason codes', async () => {
    routeHealthyEvidence();
    const result = await health.computeOperationalReadiness(NOW, mockPool, expectedValid);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    for (const process of result.processes) {
      expect(Object.keys(process).sort()).toEqual([
        'appVersion', 'failureCode', 'healthy', 'lastFailureAt', 'lastHeartbeatAt',
        'lastStartedAt', 'lastSuccessAt', 'processId', 'reasonCode',
      ].sort());
    }
  });
});
