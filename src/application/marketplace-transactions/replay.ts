import { createHash, randomUUID } from 'node:crypto';

/** Minimal key/value store; the Redis adapter implements it in production. */
export interface ReplayStore {
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  deleteIfEquals(key: string, value: string): Promise<void>;
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string, ttlSec: number): Promise<void>;
  checkRateLimit(key: string, maxRequests: number, windowSec: number): Promise<boolean>;
}

export class ReplayError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_KEY_REUSED' | 'REQUEST_IN_PROGRESS' | 'REPLAY_STORE_UNAVAILABLE') { super(code); }
}

/** Idempotency-Key header: 16 to 100 safe characters (UUIDs fit). */
export function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key');
  return key && /^[A-Za-z0-9_-]{16,100}$/.test(key) ? key : null;
}

export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const RECORD_TTL_SEC = 7 * 24 * 3600;

export interface ReplayRecord<T> { fingerprint: string; result?: T }

/**
 * Runs `work` once per (scope, key). The same key with another payload is
 * refused; a concurrent duplicate gets REQUEST_IN_PROGRESS rather than a
 * second write. `work` is told when an earlier attempt was interrupted, so it
 * can look for a write Frappe accepted before the connection dropped.
 */
export async function onceByKey<T>(
  store: ReplayStore,
  scope: string,
  key: string,
  print: string,
  work: (resumed: boolean) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const recordKey = `mkt:replay:${scope}:${key}`;
  const leaseKey = `${recordKey}:lease`;
  const lease = randomUUID();
  let owned = false;
  let resumed = false;
  try {
    const stored = await store.getValue(recordKey);
    if (stored) {
      const record = JSON.parse(stored) as ReplayRecord<T>;
      if (record.fingerprint !== print) throw new ReplayError('IDEMPOTENCY_KEY_REUSED');
      if (record.result !== undefined) return { result: record.result, replayed: true };
    }
    owned = await store.setIfAbsent(leaseKey, lease, 45_000);
    if (!owned) throw new ReplayError('REQUEST_IN_PROGRESS');
    // Re-read under the lease: a twin may have finished just before we got it.
    const again = await store.getValue(recordKey);
    if (again) {
      const record = JSON.parse(again) as ReplayRecord<T>;
      if (record.fingerprint !== print) throw new ReplayError('IDEMPOTENCY_KEY_REUSED');
      if (record.result !== undefined) return { result: record.result, replayed: true };
      // An earlier attempt started and never recorded its outcome.
      resumed = true;
    } else {
      await store.setValue(recordKey, JSON.stringify({ fingerprint: print }), RECORD_TTL_SEC);
    }
  } catch (error) {
    if (owned) await store.deleteIfEquals(leaseKey, lease).catch(() => undefined);
    if (error instanceof ReplayError) throw error;
    throw new ReplayError('REPLAY_STORE_UNAVAILABLE');
  }
  try {
    const result = await work(resumed);
    // The write is already in Frappe; failing to record it only weakens the
    // fast path, the Frappe-side lookup still finds it on replay.
    await store.setValue(recordKey, JSON.stringify({ fingerprint: print, result }), RECORD_TTL_SEC).catch(() => undefined);
    return { result, replayed: false };
  } finally {
    await store.deleteIfEquals(leaseKey, lease).catch(() => undefined);
  }
}

/** A short mutual-exclusion lease, used to serialize bookings of one room type. */
export async function withLease<T>(store: ReplayStore, key: string, work: () => Promise<T>, waitMs = 8_000): Promise<T> {
  const lease = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    let owned: boolean;
    try { owned = await store.setIfAbsent(key, lease, 30_000); } catch { throw new ReplayError('REPLAY_STORE_UNAVAILABLE'); }
    if (owned) break;
    if (Date.now() > deadline) throw new ReplayError('REQUEST_IN_PROGRESS');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  try { return await work(); } finally { await store.deleteIfEquals(key, lease).catch(() => undefined); }
}
