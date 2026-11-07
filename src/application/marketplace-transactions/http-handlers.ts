/**
 * Shared HTTP plumbing for the Marketplace routes. Each route file under
 * src/api/routes/public/marketplace/merchants/[slug]/ holds its own contract
 * (schemas, headers, statuses, error codes), which the OpenAPI generator reads.
 */
import { createHash } from 'node:crypto';
import type { RequestContext } from '../../api/http.ts';
import { FrappeSiteError, frappeSite, type FrappeSite } from './frappe-site.ts';
import { CapabilityConfigError, resolveCapability, type HotelCapability, type RestaurantCapability } from './merchant-capabilities.ts';
import { ReplayError, type ReplayStore } from './replay.ts';
import { ProjectionUnavailable, publishedCapability, sqlPublishedProfiles, type PublishedProfiles } from './published-profiles.ts';

export interface TransactionDeps {
  store: () => ReplayStore;
  site: (key: string) => FrappeSite;
  profiles: () => PublishedProfiles;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const CACHED = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' };

export const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extra } });

/** Largest JSON body a Marketplace write accepts. */
export const MAX_BODY = 16_000;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,100}$/;

export const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * Per web peer, per merchant and per visitor. Fails closed without Redis:
 * 'unavailable' is answered 503, a retry delay 429.
 */
export async function limited(deps: TransactionDeps, ctx: RequestContext, scope: string, slug: string, visitor: string | null, perPeer: number, perVisitor: number): Promise<null | 'unavailable' | { retryAfter: string }> {
  try {
    const store = deps.store();
    const peer = hash(ctx.clientAddress || 'unknown-peer');
    if (!(await store.checkRateLimit(`mkt:rl:${scope}:peer:${peer}`, perPeer, 600))) return { retryAfter: '60' };
    if (!(await store.checkRateLimit(`mkt:rl:${scope}:merchant:${slug}`, perPeer * 2, 600))) return { retryAfter: '60' };
    if (visitor && !(await store.checkRateLimit(`mkt:rl:${scope}:visitor:${hash(visitor)}`, perVisitor, 3600))) return { retryAfter: '600' };
    return null;
  } catch {
    return 'unavailable';
  }
}

/**
 * Infrastructure failures, answered 503. Frappe messages are never forwarded:
 * they can name other guests or rooms.
 */
export function unavailable(scope: string, error: unknown): { error: string; headers: Record<string, string> } {
  if (error instanceof FrappeSiteError) {
    console.error(`[marketplace-${scope}] Frappe ${error.code}`, error.httpStatus, error.excType);
    return { error: error.code === 'SITE_UNAVAILABLE' ? 'SITE_UNAVAILABLE' : 'TRANSACTIONS_UNAVAILABLE', headers: { 'Retry-After': '30' } };
  }
  if (error instanceof ProjectionUnavailable) {
    console.error(`[marketplace-${scope}] projection unavailable`);
    return { error: 'PROFILE_SOURCE_UNAVAILABLE', headers: { 'Retry-After': '30' } };
  }
  if (error instanceof ReplayError) return { error: 'TRANSACTIONS_UNAVAILABLE', headers: {} };
  if (error instanceof CapabilityConfigError) console.error(`[marketplace-${scope}] ${error.message}`);
  else console.error(`[marketplace-${scope}] unexpected failure`, error instanceof Error ? error.name : typeof error);
  return { error: 'TRANSACTIONS_UNAVAILABLE', headers: {} };
}

/**
 * A transaction needs both: the capability published for this establishment
 * in the Marketplace projection, and its server-side routing to a Frappe site.
 */
export async function capability(deps: TransactionDeps, slug: string | undefined, kind: 'restaurant'): Promise<RestaurantCapability | null>;
export async function capability(deps: TransactionDeps, slug: string | undefined, kind: 'hotel'): Promise<HotelCapability | null>;
export async function capability(deps: TransactionDeps, slug: string | undefined, kind: 'restaurant' | 'hotel'): Promise<RestaurantCapability | HotelCapability | null> {
  const cap = kind === 'restaurant' ? resolveCapability(slug ?? '', 'restaurant', deps.env) : resolveCapability(slug ?? '', 'hotel', deps.env);
  if (!cap) return null;
  return (await publishedCapability(deps.profiles(), slug!, kind)) ? cap : null;
}

export async function defaultDeps(): Promise<TransactionDeps> {
  const { redisAdapter } = await import('../../infrastructure/adapters/redis-adapter.ts');
  const { query } = await import('../../infrastructure/database/pool.ts');
  const profiles = sqlPublishedProfiles(query);
  return { store: () => redisAdapter, site: key => frappeSite(key), profiles: () => profiles, env: process.env, now: () => new Date() };
}
