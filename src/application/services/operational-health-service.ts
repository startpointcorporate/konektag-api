/**
 * GAP-024 — fail-closed operational health and aggregate readiness for
 * mandatory workers and scheduled controls (Runbook V3 P19/P20).
 *
 * Health is computed exclusively from durable evidence in
 * konektag.process_runs. Absent, stale, failed, abandoned, mismatched or
 * unavailable evidence is never treated as healthy.
 */

import pool from '../../infrastructure/database/pool.ts';
import {
  PROCESS_IDS,
  resolveAppVersion,
  type AppVersionResolution,
} from './process-evidence-service.ts';

// ── Mandatory process registry ────────────────────────────────────────────

export interface ProcessSpec {
  processId: string;
  executionType: 'worker' | 'cron';
  /** Worker: maximum accepted age of the latest liveness evidence. */
  heartbeatFreshnessSeconds?: number;
  /** Cron: expected execution cadence. */
  cadenceSeconds?: number;
  /** Cron: tolerated delay beyond the cadence. */
  graceSeconds?: number;
  /** Cron: maximum duration of a run before it is considered abandoned. */
  maxRunDurationSeconds?: number;
}

/**
 * Authoritative GAP-024 process set (docker-compose workers and scheduled
 * controls, lines 66-203). The recharge projection runs inside the Outbox
 * dispatcher: no separate projection worker process exists.
 */
export const MANDATORY_PROCESSES: ProcessSpec[] = [
  { processId: PROCESS_IDS.outboxDispatcher, executionType: 'worker', heartbeatFreshnessSeconds: 60 },
  { processId: PROCESS_IDS.accountingWorker, executionType: 'worker', heartbeatFreshnessSeconds: 60 },
  {
    processId: PROCESS_IDS.reconciliationCron, executionType: 'cron',
    cadenceSeconds: 86400, graceSeconds: 3600, maxRunDurationSeconds: 3600,
  },
  {
    processId: PROCESS_IDS.sanctionsCron, executionType: 'cron',
    cadenceSeconds: 86400, graceSeconds: 3600, maxRunDurationSeconds: 3600,
  },
  {
    processId: PROCESS_IDS.retentionCron, executionType: 'cron',
    cadenceSeconds: 86400, graceSeconds: 3600, maxRunDurationSeconds: 3600,
  },
];

// ── Health states and sanitized reason codes ──────────────────────────────

export const PROCESS_HEALTHY = 'PROCESS_HEALTHY';
export const PROCESS_NO_EVIDENCE = 'PROCESS_NO_EVIDENCE';
export const PROCESS_VERSION_INVALID = 'PROCESS_VERSION_INVALID';
export const PROCESS_VERSION_MISMATCH = 'PROCESS_VERSION_MISMATCH';
export const PROCESS_LAST_RUN_FAILED = 'PROCESS_LAST_RUN_FAILED';
export const PROCESS_HEARTBEAT_STALE = 'PROCESS_HEARTBEAT_STALE';
export const PROCESS_EXECUTION_STALE = 'PROCESS_EXECUTION_STALE';
export const PROCESS_RUN_ABANDONED = 'PROCESS_RUN_ABANDONED';
export const PROCESS_SCHEMA_MISSING = 'PROCESS_SCHEMA_MISSING';
export const PROCESS_EVIDENCE_UNAVAILABLE = 'PROCESS_EVIDENCE_UNAVAILABLE';
export const PROCESS_STATUS_UNSUPPORTED = 'PROCESS_STATUS_UNSUPPORTED';

export interface RunEvidence {
  status: string;
  app_version: string;
  failure_code: string | null;
  started_at: Date | string;
  heartbeat_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface ProcessHealth {
  processId: string;
  healthy: boolean;
  reasonCode: string;
  appVersion: string | null;
  lastStartedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCode: string | null;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function toIso(value: Date | string | null | undefined): string | null {
  const time = toTime(value);
  return time === null ? null : new Date(time).toISOString();
}

function health(
  spec: ProcessSpec,
  healthy: boolean,
  reasonCode: string,
  latest: RunEvidence | null,
  extras: Partial<ProcessHealth> = {},
): ProcessHealth {
  return {
    processId: spec.processId,
    healthy,
    reasonCode,
    appVersion: latest?.app_version ?? null,
    lastStartedAt: toIso(latest?.started_at),
    lastHeartbeatAt: toIso(latest?.heartbeat_at),
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCode: null,
    ...extras,
  };
}

/**
 * Fail-closed per-process health evaluation (pure function).
 *
 * A process is healthy only when durable evidence exists, carries the
 * expected immutable version, shows a fresh liveness signal (worker) or a
 * fresh terminal success (cron), and is not superseded by a later failure
 * or an abandoned non-terminal run.
 */
export function evaluateProcess(
  spec: ProcessSpec,
  runs: RunEvidence[],
  expected: AppVersionResolution,
  now: Date,
): ProcessHealth {
  const nowMs = now.getTime();
  const sorted = [...runs].sort(
    (a, b) => (toTime(b.started_at) ?? 0) - (toTime(a.started_at) ?? 0),
  );
  const latest = sorted[0] ?? null;

  if (!latest) {
    return health(spec, false, PROCESS_NO_EVIDENCE, null);
  }
  if (!expected.valid || !expected.version) {
    return health(spec, false, PROCESS_VERSION_INVALID, latest);
  }
  if (latest.app_version !== expected.version) {
    return health(spec, false, PROCESS_VERSION_MISMATCH, latest);
  }

  const latestTerminal = sorted.find((r) => r.status === 'SUCCEEDED' || r.status === 'FAILED') ?? null;
  const latestSuccess = sorted.find((r) => r.status === 'SUCCEEDED') ?? null;
  const latestFailure = sorted.find((r) => r.status === 'FAILED') ?? null;
  const latestNonTerminal = sorted.find((r) => r.status === 'STARTED' || r.status === 'RUNNING') ?? null;
  const unsupported = sorted.find(
    (r) => !['STARTED', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(r.status),
  );
  if (unsupported) {
    return health(spec, false, PROCESS_STATUS_UNSUPPORTED, unsupported);
  }

  const lastSuccessAt = toIso(latestSuccess?.completed_at);
  const lastFailureAt = toIso(latestFailure?.completed_at);

  if (spec.executionType === 'worker') {
    if (latest.status === 'FAILED') {
      return health(spec, false, PROCESS_LAST_RUN_FAILED, latest, {
        lastSuccessAt, lastFailureAt, failureCode: latest.failure_code,
      });
    }
    // Liveness: heartbeat when running, completion timestamp for a cleanly
    // stopped worker, start timestamp before the first heartbeat.
    const liveness = toTime(latest.heartbeat_at)
      ?? toTime(latest.completed_at)
      ?? toTime(latest.started_at);
    const freshnessMs = (spec.heartbeatFreshnessSeconds ?? 60) * 1000;
    if (liveness === null || nowMs - liveness > freshnessMs) {
      return health(spec, false, PROCESS_HEARTBEAT_STALE, latest, { lastSuccessAt, lastFailureAt });
    }
    return health(spec, true, PROCESS_HEALTHY, latest, { lastSuccessAt, lastFailureAt });
  }

  // Scheduled control (cron).
  if (
    latestNonTerminal
    && spec.maxRunDurationSeconds !== undefined
    && nowMs - (toTime(latestNonTerminal.started_at) ?? 0) > spec.maxRunDurationSeconds * 1000
  ) {
    return health(spec, false, PROCESS_RUN_ABANDONED, latestNonTerminal, {
      lastSuccessAt, lastFailureAt,
    });
  }

  const successMs = toTime(latestSuccess?.completed_at);
  const failureMs = toTime(latestFailure?.completed_at);
  if (latestFailure && (successMs === null || (failureMs ?? 0) > successMs)) {
    return health(spec, false, PROCESS_LAST_RUN_FAILED, latestFailure, {
      lastSuccessAt, lastFailureAt, failureCode: latestFailure.failure_code,
    });
  }
  const freshnessMs = ((spec.cadenceSeconds ?? 86400) + (spec.graceSeconds ?? 0)) * 1000;
  if (successMs === null || nowMs - successMs > freshnessMs) {
    return health(spec, false, PROCESS_EXECUTION_STALE, latestTerminal ?? latest, {
      lastSuccessAt, lastFailureAt,
    });
  }
  return health(spec, true, PROCESS_HEALTHY, latest, { lastSuccessAt, lastFailureAt });
}

// ── Aggregate readiness ───────────────────────────────────────────────────

export interface AggregateReadiness {
  ready: boolean;
  version: string | null;
  reasonCode: string;
  processes: ProcessHealth[];
}

export const AGGREGATE_READY = 'AGGREGATE_READY';
export const AGGREGATE_VERSION_INVALID = 'AGGREGATE_VERSION_INVALID';
export const AGGREGATE_PROCESS_UNHEALTHY = 'AGGREGATE_PROCESS_UNHEALTHY';

export function aggregateReadiness(
  healths: ProcessHealth[],
  expected: AppVersionResolution,
): AggregateReadiness {
  if (!expected.valid || !expected.version) {
    return { ready: false, version: expected.version, reasonCode: AGGREGATE_VERSION_INVALID, processes: healths };
  }
  const unhealthy = healths.filter((h) => !h.healthy);
  return {
    ready: unhealthy.length === 0,
    version: expected.version,
    reasonCode: unhealthy.length === 0 ? AGGREGATE_READY : AGGREGATE_PROCESS_UNHEALTHY,
    processes: healths,
  };
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

async function loadRecentRuns(spec: ProcessSpec, client: Queryable): Promise<RunEvidence[]> {
  const { rows } = await client.query(
    `SELECT status, app_version, failure_code, started_at, heartbeat_at, completed_at
       FROM konektag.process_runs
      WHERE process_id = $1
      ORDER BY started_at DESC
      LIMIT 10`,
    [spec.processId],
  );
  return rows;
}

const PG_UNDEFINED_TABLE = '42P01';

/**
 * Compute the authoritative aggregate operational readiness from durable
 * evidence. Every evidence-query failure fails closed: a missing schema or
 * an unavailable database produces an unhealthy process, never a healthy one.
 */
export async function computeOperationalReadiness(
  now: Date = new Date(),
  client: Queryable = pool as unknown as Queryable,
  expected: AppVersionResolution = resolveAppVersion(),
): Promise<AggregateReadiness> {
  const healths: ProcessHealth[] = [];
  for (const spec of MANDATORY_PROCESSES) {
    let runs: RunEvidence[];
    try {
      runs = await loadRecentRuns(spec, client);
    } catch (err) {
      const code = (err as { code?: string }).code;
      healths.push(health(
        spec,
        false,
        code === PG_UNDEFINED_TABLE ? PROCESS_SCHEMA_MISSING : PROCESS_EVIDENCE_UNAVAILABLE,
        null,
      ));
      continue;
    }
    healths.push(evaluateProcess(spec, runs, expected, now));
  }
  return aggregateReadiness(healths, expected);
}
