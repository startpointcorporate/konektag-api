import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

const VALID_SHA = '0fab507e5511e297e0a225cb284727cfb47f4780';
const OTHER_SHA = 'd18fa00502dfa9d81911fba30b7b06f91f420a07';
const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;

let failStartInsert = false;
let terminalRowCount = 1;
let failTerminalUpdate = false;

let service: any;
let errorSpy: ReturnType<typeof vi.spyOn>;

const savedEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...savedEnv, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  failStartInsert = false;
  terminalRowCount = 1;
  failTerminalUpdate = false;
  mockPool.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('INSERT INTO konektag.process_runs')) {
      if (failStartInsert) throw new Error('insert relation unavailable');
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE konektag.process_runs')) {
      if (failTerminalUpdate) throw new Error('terminal relation unavailable');
      return { rows: [], rowCount: terminalRowCount };
    }
    return { rows: [] };
  });
  service = await import('../../src/application/services/process-evidence-service.ts');
});

afterEach(() => {
  errorSpy.mockRestore();
  process.env = { ...savedEnv };
});

const callsMatching = (fragment: string) =>
  mockPool.query.mock.calls.filter(([sql]: any) => String(sql).includes(fragment));

describe('process-evidence — immutable application version', () => {
  it('accepts a full Git commit SHA in deployment mode', () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA.toUpperCase() });
    const result = service.resolveAppVersion();
    expect(result.valid).toBe(true);
    expect(result.version).toBe(VALID_SHA);
    expect(result.deploymentMode).toBe(true);
  });

  it('accepts an immutable artifact digest in deployment mode', () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_DIGEST });
    const result = service.resolveAppVersion();
    expect(result.valid).toBe(true);
    expect(result.version).toBe(VALID_DIGEST);
  });

  it('fails deployment mode when the version identity is missing', () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: undefined });
    const result = service.resolveAppVersion();
    expect(result.valid).toBe(false);
    expect(result.version).toBeNull();
  });

  it('rejects mutable or malformed identities', () => {
    for (const mutable of ['latest', 'main', 'fix/runbook-v3-compliance-remediation', '0fab507', 'v1.2.3']) {
      setEnv({ NODE_ENV: 'production', APP_VERSION: mutable });
      expect(service.resolveAppVersion().valid).toBe(false);
    }
  });

  it('uses a local non-deployed fallback outside deployment mode', () => {
    setEnv({ NODE_ENV: 'development', APP_VERSION: undefined });
    const result = service.resolveAppVersion();
    expect(result.valid).toBe(true);
    expect(result.version).toBe('dev-local');
    expect(result.deploymentMode).toBe(false);
  });
});

describe('process-evidence — sanitized failure codes', () => {
  it('retains an already stable reason code', () => {
    expect(service.toFailureCode(new Error('RECONCILIATION_CONTEXT_MISSING'))).toBe('RECONCILIATION_CONTEXT_MISSING');
  });

  it('redacts messages containing personal data or secrets', () => {
    const code = service.toFailureCode(new Error('User alice@example.com exploded with token s3cr3t'));
    expect(code).toBe('PROCESS_EXECUTION_FAILED');
    expect(code).not.toContain('alice@example.com');
  });

  it('redacts connection strings entirely', () => {
    const code = service.toFailureCode(new Error('connect failed postgres://user:password@db:5432/postgres'));
    expect(code).toBe('PROCESS_EXECUTION_FAILED');
    expect(code).not.toContain('postgres://');
    expect(code).not.toContain('password');
  });
});

describe('process-evidence — worker registration and heartbeat', () => {
  it('registers a worker run with the immutable version and returns the run identity', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    const runId = await service.registerWorkerRun(service.PROCESS_IDS.accountingWorker);

    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    const insert = callsMatching('INSERT INTO konektag.process_runs');
    expect(insert).toHaveLength(1);
    expect(insert[0][1][0]).toBe('accounting-worker');
    expect(insert[0][1][1]).toBe(runId);
    expect(insert[0][1][2]).toBe('worker');
    expect(insert[0][1][3]).toBe(VALID_SHA);
    expect(insert[0][0]).toContain("'STARTED'");
  });

  it('never breaks worker startup when registration persistence fails', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    failStartInsert = true;
    const runId = await service.registerWorkerRun(service.PROCESS_IDS.outboxDispatcher);
    expect(runId).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('persists idempotent heartbeats restricted to non-terminal runs', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    await service.recordWorkerHeartbeat(service.PROCESS_IDS.outboxDispatcher, 'run-1');

    const update = callsMatching('UPDATE konektag.process_runs');
    expect(update).toHaveLength(1);
    expect(update[0][0]).toContain('heartbeat_at = now()');
    expect(update[0][0]).toContain("status IN ('STARTED', 'RUNNING')");
    expect(update[0][1]).toEqual(['outbox-dispatcher', 'run-1']);
  });

  it('propagates heartbeat persistence failure so health fails closed', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    failTerminalUpdate = true;
    await expect(
      service.recordWorkerHeartbeat(service.PROCESS_IDS.outboxDispatcher, 'run-1'),
    ).rejects.toThrow('terminal relation unavailable');
  });
});

describe('process-evidence — scheduled control execution', () => {
  it('persists start and terminal success with the immutable version', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    const work = vi.fn().mockResolvedValue(undefined);

    await service.runCronWithEvidence(service.PROCESS_IDS.reconciliationCron, work);

    expect(work).toHaveBeenCalledTimes(1);
    const insert = callsMatching('INSERT INTO konektag.process_runs');
    expect(insert[0][1][0]).toBe('reconciliation-cron');
    expect(insert[0][1][2]).toBe('cron');
    expect(insert[0][1][3]).toBe(VALID_SHA);
    const succeed = callsMatching('UPDATE konektag.process_runs');
    expect(succeed).toHaveLength(1);
    expect(succeed[0][1][2]).toBe('SUCCEEDED');
  });

  it('persists a sanitized terminal failure and rethrows when the work fails', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    const failure = new Error('RECONCILIATION_CONTEXT_MISSING context for alice@example.com');

    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.reconciliationCron, async () => { throw failure; }),
    ).rejects.toThrow(failure.message);

    const fail = callsMatching('UPDATE konektag.process_runs');
    expect(fail).toHaveLength(1);
    expect(fail[0][1][2]).toBe('FAILED');
    expect(fail[0][1][3]).toBe('RECONCILIATION_CONTEXT_MISSING');
    expect(JSON.stringify(fail[0][1])).not.toContain('alice@example.com');
  });

  it('does not run the work when the start record cannot be persisted', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    failStartInsert = true;
    const work = vi.fn();

    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.retentionCron, work),
    ).rejects.toThrow('insert relation unavailable');
    expect(work).not.toHaveBeenCalled();
  });

  it('fails closed when the terminal success record is not durably written', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    terminalRowCount = 0; // terminal UPDATE matched no non-terminal row

    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.retentionCron, async () => {}),
    ).rejects.toThrow('PROCESS_RUN_TERMINAL_PERSISTENCE_FAILED');
  });

  it('propagates terminal-failure persistence errors instead of swallowing them', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: VALID_SHA });
    failTerminalUpdate = true;

    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.sanctionsCron, async () => {
        throw new Error('WORK exploded');
      }),
    ).rejects.toThrow('terminal relation unavailable');
  });

  it('refuses unversioned execution in deployment mode with terminal evidence', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: 'latest' });
    const work = vi.fn();

    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.sanctionsCron, work),
    ).rejects.toThrow('APP_VERSION_INVALID');

    expect(work).not.toHaveBeenCalled();
    expect(callsMatching('INSERT INTO konektag.process_runs')).toHaveLength(1);
    const fail = callsMatching('UPDATE konektag.process_runs');
    expect(fail[0][1][2]).toBe('FAILED');
    expect(fail[0][1][3]).toBe('APP_VERSION_INVALID');
  });

  it('keeps each run terminally consistent: a second terminal update is rejected', async () => {
    setEnv({ NODE_ENV: 'production', APP_VERSION: OTHER_SHA });
    // First terminal transition succeeds (rowCount 1), a contradictory second
    // one finds no non-terminal row (rowCount 0) and fails closed.
    await service.runCronWithEvidence(service.PROCESS_IDS.sanctionsCron, async () => {});
    terminalRowCount = 0;
    await expect(
      service.runCronWithEvidence(service.PROCESS_IDS.sanctionsCron, async () => {}),
    ).rejects.toThrow('PROCESS_RUN_TERMINAL_PERSISTENCE_FAILED');
  });
});
