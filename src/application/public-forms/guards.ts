/**
 * Shared protections of the anonymous public forms.
 *
 * - JSON only, bounded body: a cross-site HTML form cannot send it without a CORS
 *   preflight, and the forms carry no ambient authority (no cookie, no session).
 * - Honeypot field, distributed Redis rate limits, optional Cloudflare Turnstile.
 * - Personal data never reaches the logs: emails and peers are keyed hashes.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

export type FormStore = {
  checkRateLimit(key: string, maxRequests: number, windowSec: number): Promise<boolean>;
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  deleteIfEquals(key: string, value: string): Promise<void>;
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string, ttlSec: number): Promise<void>;
};

export class FormError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'FormError';
  }
}

export const reply = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function readJson(request: Request, maxBytes = 16_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw new FormError('BAD_CONTENT_TYPE', 415);
  const raw = await request.text();
  if (raw.length > maxBytes) throw new FormError('PAYLOAD_TOO_LARGE', 413);
  try { return JSON.parse(raw); } catch { throw new FormError('BAD_JSON', 400); }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Keyed hash of a personal value for logs and proofs; never reversible without the server secret. */
export function pseudonym(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

/** Independent limits per email and per TCP peer (clientAddress, not X-Forwarded-For). */
export async function enforceRateLimits(
  store: FormStore,
  scope: string,
  limits: Array<{ key: string; max: number; windowSec: number }>,
): Promise<void> {
  let allowed: boolean[];
  try {
    allowed = await Promise.all(limits.map(l => store.checkRateLimit(`public-forms:${scope}:${l.key}`, l.max, l.windowSec)));
  } catch {
    throw new FormError('SERVICE_UNAVAILABLE', 503);
  }
  if (allowed.some(ok => !ok)) throw new FormError('RATE_LIMITED', 429);
}

/**
 * Turnstile is optional for the server. When it has a secret, a token sent by the
 * page must be valid for this action and, when known, for the page host; with
 * `required`, a missing token is refused too.
 */
export async function verifyTurnstile(
  token: string, action: string, origin: string | null,
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, required = false,
): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return;
  if (!token) {
    if (required) throw new FormError('INVALID_VERIFICATION', 403);
    return;
  }
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }), signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error('turnstile');
    result = await response.json() as typeof result;
  } catch {
    throw new FormError('VERIFICATION_UNAVAILABLE', 503);
  }
  let host: string | null = null;
  try { host = origin ? new URL(origin).hostname : null; } catch { host = null; }
  if (result.success !== true || result.action !== action || (host !== null && result.hostname !== host))
    throw new FormError('INVALID_VERIFICATION', 403);
}

/** One JSON line per form event, without personal data. */
export function logFormEvent(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.info('[public-forms]', JSON.stringify({ event, ...fields }));
}

/** Exclusive lease, longer than the sequential Frappe calls it protects (10 s timeout each). */
export async function withLease<T>(store: FormStore, key: string, run: () => Promise<T>): Promise<T> {
  const owner = randomUUID();
  let acquired: boolean;
  try { acquired = await store.setIfAbsent(key, owner, 90_000); }
  catch { throw new FormError('SERVICE_UNAVAILABLE', 503); }
  if (!acquired) throw new FormError('REQUEST_IN_PROGRESS', 409);
  try { return await run(); }
  finally { await store.deleteIfEquals(key, owner).catch(() => undefined); }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** The secret of form tokens and pseudonyms; at least 32 characters, never sent to a browser. */
export function formSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.PUBLIC_FORMS_TOKEN_SECRET ?? '';
  if (secret.length < 32) throw new FormError('SERVICE_UNAVAILABLE', 503);
  return secret;
}
