/**
 * GAP-024 — durable execution evidence for mandatory workers and scheduled
 * controls (Runbook V3 P19/P20).
 *
 * Every mandatory process registers its runs in konektag.process_runs with an
 * immutable application version, controlled heartbeats, and a terminal
 * SUCCEEDED/FAILED outcome carrying only a sanitized reason code.
 *
 * Fail-closed contract:
 *  - a started execution without durable terminal evidence is never a success;
 *  - a cron that cannot persist its start record does not run;
 *  - a cron whose terminal record cannot be persisted propagates the failure
 *    (non-zero exit) instead of reporting success;
 *  - a worker whose evidence cannot be persisted keeps serving but its health
 *    evaluation goes stale and reports unhealthy.
 */

import crypto from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';

/** Mandatory GAP-024 process identifiers (authoritative, stable). */
export const PROCESS_IDS = {
  outboxDispatcher: 'outbox-dispatcher',
  accountingWorker: 'accounting-worker',
  reconciliationCron: 'reconciliation-cron',
  sanctionsCron: 'sanctions-cron',
  retentionCron: 'retention-cron',
} as const;

export type ProcessId = (typeof PROCESS_IDS)[keyof typeof PROCESS_IDS];

// ── Immutable application version identity ────────────────────────────────

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
/** Fallback used only outside deployment mode, never a deployed identity. */
const DEV_LOCAL_VERSION = 'dev-local';

export interface AppVersionResolution {
  /** The identity to persist on evidence rows; null when missing in deployment mode. */
  version: string | null;
  /** Whether the identity is an acceptable immutable deployment identity. */
  valid: boolean;
  deploymentMode: boolean;
}

/**
 * Resolve the immutable deployment identity from the APP_VERSION environment
 * variable. Accepts a full Git commit SHA or an immutable artifact digest.
 * Branch names, `latest`, partial SHAs and free-form descriptions are
 * rejected. In deployment mode a missing identity is invalid and must fail
 * readiness; outside deployment mode a local fallback keeps development
 * usable without ever being accepted as a deployed identity.
 */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): AppVersionResolution {
  const deploymentMode = env.NODE_ENV === 'production';
  const raw = (env.APP_VERSION ?? '').trim();
  if (!raw) {
    return deploymentMode
      ? { version: null, valid: false, deploymentMode }
      : { version: DEV_LOCAL_VERSION, valid: true, deploymentMode };
  }
  const valid = GIT_SHA_PATTERN.test(raw) || ARTIFACT_DIGEST_PATTERN.test(raw);
  return { version: raw.toLowerCase(), valid, deploymentMode };
}

// ── Sanitized failure codes ───────────────────────────────────────────────

const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,59}$/;
const GENERIC_FAILURE_CODE = 'PROCESS_EXECUTION_FAILED';

/**
 * Reduce an arbitrary thrown error to a stable, sanitized reason code.
 * Raw messages and stack traces are never persisted: only an already-stable
 * UPPER_SNAKE code token is retained, otherwise a generic code is used.
 */
export function toFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstToken = (message || '').split(/[\s:]+/, 1)[0] ?? '';
  return STABLE_CODE_PATTERN.test(firstToken) ? firstToken : GENERIC_FAILURE_CODE;
}

// ── Durable run persistence ───────────────────────────────────────────────

export type ExecutionType = 'worker' | 'cron';

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

const db: Queryable = pool as unknown as Queryable;

async function startRun(
  processId: string,
  runId: string,
  executionType: ExecutionType,
  appVersion: string,
  correlationId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO konektag.process_runs
       (process_id, run_id, execution_type, app_version, status, correlation_id)
     VALUES ($1, $2, $3, $4, 'STARTED', $5)`,
    [processId, runId, executionType, appVersion, correlationId ?? null],
  );
}

/**
 * Idempotent heartbeat: restricted to non-terminal rows so a completed run
 * can never be revived or contradicted by a late heartbeat.
 */
async function heartbeat(processId: string, runId: string): Promise<void> {
  await db.query(
    `UPDATE konektag.process_runs
        SET status = 'RUNNING', heartbeat_at = now(), updated_at = now()
      WHERE process_id = $1 AND run_id = $2 AND status IN ('STARTED', 'RUNNING')`,
    [processId, runId],
  );
}

/**
 * Terminal transition. Restricted to non-terminal rows: a run can reach
 * exactly one terminal state. A zero-row update means the terminal evidence
 * was NOT durably recorded and is treated as a persistence failure
 * (fail closed) rather than a success.
 */
async function finishRun(
  processId: string,
  runId: string,
  status: 'SUCCEEDED' | 'FAILED',
  failureCode?: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE konektag.process_runs
        SET status = $3, completed_at = now(), failure_code = $4, updated_at = now()
      WHERE process_id = $1 AND run_id = $2 AND status IN ('STARTED', 'RUNNING')`,
    [processId, runId, status, status === 'FAILED' ? failureCode : null],
  );
  if (!result.rowCount) {
    throw new Error('PROCESS_RUN_TERMINAL_PERSISTENCE_FAILED');
  }
}

// ── Long-running worker instrumentation ───────────────────────────────────

/**
 * Register a worker run. Never breaks worker startup: a registration failure
 * is logged and reported through health evaluation (missing/stale evidence
 * fails closed) instead of crashing the worker.
 *
 * @returns the run identity to heartbeat with, or null when the registration
 *          could not be persisted.
 */
export async function registerWorkerRun(processId: ProcessId): Promise<string | null> {
  const { version, valid, deploymentMode } = resolveAppVersion();
  if (!valid) {
    console.error(
      `[process-evidence] ${processId}: ${deploymentMode ? 'missing or invalid' : 'invalid'} APP_VERSION identity`,
    );
  }
  const runId = crypto.randomUUID();
  try {
    await startRun(processId, runId, 'worker', version ?? 'MISSING');
    return runId;
  } catch (err) {
    console.error(
      `[process-evidence] ${processId}: run registration failed:`,
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Persist one worker heartbeat. Throws on persistence failure: the caller
 * decides to keep serving, while health evaluation fails closed on the
 * resulting stale evidence.
 */
export async function recordWorkerHeartbeat(processId: ProcessId, runId: string): Promise<void> {
  await heartbeat(processId, runId);
}

// ── Scheduled control (cron) instrumentation ──────────────────────────────

/**
 * Execute a mandatory scheduled control with durable start and terminal
 * evidence.
 *
 * Fail closed:
 *  - when the start record cannot be persisted, the work does not run;
 *  - in deployment mode, a missing or malformed immutable version records a
 *    terminal APP_VERSION_INVALID failure and the work does not run;
 *  - when the work throws, a terminal FAILED record is persisted (sanitized
 *    reason code) and the error is rethrown so the run cannot look successful;
 *  - when the terminal record cannot be persisted, the error propagates.
 */
export async function runCronWithEvidence(
  processId: ProcessId,
  work: () => Promise<void>,
): Promise<void> {
  const { version, valid, deploymentMode } = resolveAppVersion();
  const runId = crypto.randomUUID();
  await startRun(processId, runId, 'cron', version ?? 'MISSING');

  if (deploymentMode && !valid) {
    await finishRun(processId, runId, 'FAILED', 'APP_VERSION_INVALID');
    throw new Error('APP_VERSION_INVALID');
  }

  try {
    await work();
  } catch (err) {
    await finishRun(processId, runId, 'FAILED', toFailureCode(err));
    throw err;
  }
  await finishRun(processId, runId, 'SUCCEEDED');
}
