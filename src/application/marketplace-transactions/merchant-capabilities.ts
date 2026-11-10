import { z } from 'zod';

/**
 * Server-side routing of a public merchant to the Frappe site that runs each
 * transactional capability. The browser only sends the public slug; it can
 * never choose a site, outlet or reception.
 *
 * Source: MARKETPLACE_TRANSACTION_MERCHANTS (JSON, deployment configuration).
 * A Konektag entity (konektag-fr, konektag-cg, konektag-lb) is an entry whose
 * `site` sits at slug level: it names the Frappe site of that legal entity.
 * Its credentials stay in MARKETPLACE_FRAPPE_<SITE>_URL / _API_KEY / _API_SECRET.
 * When the Marketplace projection of API #24 is delivered, the published
 * capabilities of the projection gate this map: a capability absent from the
 * projection stays unavailable even if it is configured here.
 */

const siteKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);
const restaurant = z.object({
  site: siteKey,
  posProfile: z.string().min(1).max(140),
  orderType: z.enum(['Takeaway', 'Delivery', 'Dine in']).default('Takeaway'),
  // Delivery-app row of LumenPOS Settings; the till needs it to charge the order.
  channel: z.string().min(1).max(60).default('Konektag'),
}).strict();
const hotel = z.object({
  site: siteKey,
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(3).max(64).default('Africa/Brazzaville'),
  maxNights: z.number().int().min(1).max(90).default(30),
  // Unique Hotel Reservation field holding the Idempotency-Key (konektag_360#14).
  // Absent: an interrupted booking is reported as of unknown outcome, never retried.
  externalReferenceField: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).optional(),
}).strict();
const merchant = z.object({ site: siteKey.optional(), restaurant: restaurant.optional(), hotel: hotel.optional() }).strict();
const registry = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160), merchant);

export type RestaurantCapability = z.infer<typeof restaurant>;
export type HotelCapability = z.infer<typeof hotel>;
export type MerchantCapabilities = z.infer<typeof merchant>;

export class CapabilityConfigError extends Error {}

export function loadCapabilities(env: NodeJS.ProcessEnv = process.env): Record<string, MerchantCapabilities> {
  const raw = env.MARKETPLACE_TRANSACTION_MERCHANTS;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CapabilityConfigError('MARKETPLACE_TRANSACTION_MERCHANTS is not JSON'); }
  const result = registry.safeParse(parsed);
  if (!result.success) throw new CapabilityConfigError('MARKETPLACE_TRANSACTION_MERCHANTS is invalid');
  return result.data;
}

/** Frappe site key configured at slug level (Konektag entities), or null. */
export function resolveSlugSite(slug: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPublicSlug(slug)) return null;
  const merchants = loadCapabilities(env);
  return Object.hasOwn(merchants, slug) ? merchants[slug].site ?? null : null;
}

export const isPublicSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function resolveCapability(slug: string, capability: 'restaurant', env?: NodeJS.ProcessEnv): RestaurantCapability | null;
export function resolveCapability(slug: string, capability: 'hotel', env?: NodeJS.ProcessEnv): HotelCapability | null;
export function resolveCapability(slug: string, capability: 'restaurant' | 'hotel', env: NodeJS.ProcessEnv = process.env) {
  if (!isPublicSlug(slug)) return null;
  const merchants = loadCapabilities(env);
  if (!Object.hasOwn(merchants, slug)) return null;
  return merchants[slug][capability] ?? null;
}
