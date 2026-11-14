import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EncryptionService } from '../../infrastructure/adapters/encryption.ts';
import { FrappeSiteError } from './frappe-site.ts';
import type { RestaurantCapability } from './merchant-capabilities.ts';
import type { TransactionDeps } from './http-handlers.ts';
import { issueSelection, issueTracking } from './restaurant-modes.ts';
import { durableOrderKey } from './restaurant-modes.ts';
import { requestKeyOf } from './restaurant-reservation-requests.ts';

export const MANAGEMENT_TTL_MS = 90 * 24 * 60 * 60_000;
export const MANAGEMENT_RENEW_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const ManagementKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ManagementTokenSchema = z.string().min(44).max(2048);
export const ActivityTypeSchema = z.enum(['order', 'reservation']);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;
const customer = z.object({ name: z.string().max(140), phone: z.string().max(40), email: z.string().max(254).optional() });
const reservation = z.object({ reference: z.string().max(140), date: z.string(), time: z.string(), partySize: z.number().int().positive() });
export const ReservationSnapshotSchema = reservation.extend({
  status: z.string().max(40), canCancel: z.boolean(), canAssociate: z.boolean(),
  customer: customer.optional(), note: z.string().max(2000).optional(),
});
export const OrderSnapshotSchema = z.object({
  reference: z.string().min(1).max(140), status: z.enum(['Open', 'Closed', 'Cancelled', 'Merged']),
  acceptanceStatus: z.enum(['Pending', 'Accepted', 'Rejected']),
  trackingStatus: z.enum(['Pending', 'Accepted', 'Preparing', 'Ready', 'Completed', 'Cancelled']),
  createdAt: z.string().optional(), orderMode: z.enum(['pickup', 'reservation']),
  currency: z.string().regex(/^[A-Z]{3}$/), total: z.number().finite().nonnegative(),
  lines: z.array(z.object({ itemCode: z.string().max(140), itemName: z.string().max(300), quantity: z.number().finite().positive(), unitPrice: z.number().finite().nonnegative(), amount: z.number().finite().nonnegative() })).max(200),
  canEdit: z.boolean(), customer: customer.optional(), note: z.string().max(2000).optional(),
  reservation: reservation.nullable().optional(), merchantName: z.string().max(200).optional(),
});
export const BrowserActivitySchema = z.object({
  index: z.number().int().nonnegative(), state: z.enum(['active', 'terminal', 'not_found', 'pending']), type: ActivityTypeSchema,
  reference: z.string().max(140).optional(), createdAt: z.string().optional(), version: z.string().min(1).max(128).optional(),
  snapshot: z.union([ReservationSnapshotSchema, OrderSnapshotSchema]).optional(),
  managementToken: ManagementTokenSchema.optional(), trackingToken: z.string().optional(), reservationToken: z.string().optional(),
});
export type BrowserActivity = z.infer<typeof BrowserActivitySchema>;
export const BrowserActivitiesInputSchema = z.object({ activities: z.array(z.union([
  z.object({ type: ActivityTypeSchema, managementToken: ManagementTokenSchema }).strict(),
  z.object({ type: ActivityTypeSchema, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), managementKey: ManagementKeySchema }).strict(),
])).max(20) }).strict().refine(value => ['order', 'reservation'].every(type => value.activities.filter(a => a.type === type).length <= 10));
const claimsSchema = z.object({ purpose: z.literal('marketplace-browser-management-v1'), type: ActivityTypeSchema,
  slug: z.string(), site: z.string(), posProfile: z.string(), reference: z.string().min(1).max(140),
  ownerHash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int(),
}).strict();
type Claims = z.infer<typeof claimsSchema>;
type TokenDeps = Pick<TransactionDeps, 'env' | 'now'>;
export class BrowserManagementError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function cipher(deps: TokenDeps) {
  const key = Buffer.from(deps.env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('Management encryption unavailable');
  return new EncryptionService(key);
}
export function ownerHash(slug: string, cap: RestaurantCapability, type: ActivityType, key: string) {
  ManagementKeySchema.parse(key);
  return createHash('sha256').update(JSON.stringify(['marketplace-browser-owner-v1', type, slug, cap.site, cap.posProfile, key])).digest('hex');
}
export function issueManagement(deps: TokenDeps, slug: string, cap: RestaurantCapability, type: ActivityType, reference: string, hash: string) {
  const value = claimsSchema.parse({ purpose: 'marketplace-browser-management-v1', type, slug, site: cap.site, posProfile: cap.posProfile, reference, ownerHash: hash, expires: deps.now().getTime() + MANAGEMENT_TTL_MS });
  return cipher(deps).encrypt(JSON.stringify(value)).toString('base64url');
}
export function readManagement(deps: TokenDeps, slug: string, cap: RestaurantCapability, token: string, type?: ActivityType): Claims {
  const encryption = cipher(deps);
  try {
    ManagementTokenSchema.parse(token);
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const value = claimsSchema.parse(JSON.parse(encryption.decrypt(Buffer.from(token, 'base64url'))));
    if (value.slug !== slug || value.site !== cap.site || value.posProfile !== cap.posProfile || (type && value.type !== type)) throw new Error();
    return value;
  } catch { throw new BrowserManagementError('ACTIVITY_NOT_FOUND', 404); }
}
const nativeSchema = z.object({ index: z.number().int().optional(), state: z.enum(['active', 'terminal', 'not_found', 'pending']),
  type: ActivityTypeSchema.optional(), reference: z.string().max(140).optional(), createdAt: z.string().optional(),
  version: z.string().min(1).max(128).optional(), snapshot: z.unknown().optional(), ownerVerified: z.boolean().optional(), replayed: z.boolean().optional(),
});
const statuses: Record<string, number> = { ACTIVITY_NOT_FOUND: 404, MANAGEMENT_NOT_AVAILABLE: 409, VERSION_CONFLICT: 409,
  RESERVATION_NOT_CANCELLABLE: 409, ORDER_NOT_EDITABLE: 409, IDEMPOTENCY_KEY_REUSED: 422,
  PRICE_CHANGED: 409, ITEM_UNAVAILABLE: 409, CURRENCY_MISMATCH: 422, INVALID_REQUEST: 400, INVALID_ORDER: 400, CAPABILITY_NOT_AVAILABLE: 404, TOO_MANY_REQUESTS: 429 };
export async function browserCall(deps: TransactionDeps, cap: RestaurantCapability, method: string, args: Record<string, unknown>): Promise<any> {
  try {
    const value = await deps.site(cap.site).call('konektag_360.marketplace_orders.api.' + method, args);
    if (value?.error) throw new FrappeSiteError('SITE_REJECTED', 417, null, value.error);
    return value;
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED') {
      for (const [code, status] of Object.entries(statuses)) if (new RegExp('\\b' + code + '\\b').test(error.serverMessage ?? '')) throw new BrowserManagementError(code, status);
    }
    throw error;
  }
}
export function publicActivity(deps: TokenDeps, slug: string, cap: RestaurantCapability, index: number, type: ActivityType,
  hash: string, raw: unknown, previous?: { token: string; claims: Claims }): BrowserActivity {
  const row = nativeSchema.parse(raw);
  if (row.index !== undefined && row.index !== index) throw new Error('Native activity order mismatch');
  if (row.type && row.type !== type) throw new Error('Native activity type mismatch');
  if (row.state === 'not_found' || row.state === 'pending') return { index, type, state: row.state };
  if (!row.ownerVerified || !row.reference || !row.version || !row.createdAt) throw new BrowserManagementError('MANAGEMENT_NOT_AVAILABLE', 409);
  if (previous && row.reference !== previous.claims.reference) throw new Error('Native ownership reference mismatch');
  const snapshot = type === 'order' ? OrderSnapshotSchema.parse(row.snapshot) : ReservationSnapshotSchema.parse(row.snapshot);
  if (snapshot.reference !== row.reference) throw new Error('Native snapshot reference mismatch');
  const activity: BrowserActivity = { index, type, state: row.state, reference: row.reference, createdAt: row.createdAt, version: row.version, snapshot };
  if (row.state === 'active') {
    activity.managementToken = previous && previous.claims.expires - deps.now().getTime() > MANAGEMENT_RENEW_WINDOW_MS
      ? previous.token : issueManagement(deps, slug, cap, type, row.reference, hash);
  }
  if (type === 'order') activity.trackingToken = issueTracking(deps, slug, cap, row.reference);
  else if (row.state === 'active' && ReservationSnapshotSchema.parse(snapshot).canAssociate) activity.reservationToken = issueSelection(deps, slug, cap, row.reference);
  return activity;
}
export async function reconcileActivities(deps: TransactionDeps, slug: string, cap: RestaurantCapability, input: z.infer<typeof BrowserActivitiesInputSchema>) {
  const prepared = input.activities.map(entry => {
    if ('managementToken' in entry) {
      try {
        const claims = readManagement(deps, slug, cap, entry.managementToken, entry.type);
        return { type: entry.type, owner_hash: claims.ownerHash, reference: claims.reference, previous: { token: entry.managementToken, claims } };
      } catch (error) { if (error instanceof BrowserManagementError) return null; throw error; }
    }
    return { type: entry.type, owner_hash: ownerHash(slug, cap, entry.type, entry.managementKey),
      request_key: entry.type === 'order' ? durableOrderKey(slug, cap, entry.idempotencyKey) : requestKeyOf(entry.idempotencyKey) };
  });
  // Keep input indices even when a malformed capability is rejected locally.
  const calls = prepared.flatMap((entry, index) => entry ? [{ index, type: entry.type, owner_hash: entry.owner_hash,
    ...('reference' in entry ? { reference: entry.reference } : { request_key: entry.request_key }) }] : []);
  const response = calls.length ? await browserCall(deps, cap, 'browser_reconcile', { slug, pos_profile: cap.posProfile, activities: calls }) : { activities: [] };
  if (!Array.isArray(response?.activities) || response.activities.length !== calls.length) throw new Error('Native activity response mismatch');
  let cursor = 0;
  return prepared.map((entry, index) => entry ? publicActivity(deps, slug, cap, index, entry.type, entry.owner_hash, response.activities[cursor++], 'previous' in entry ? entry.previous : undefined)
    : { index, type: input.activities[index].type, state: 'not_found' as const });
}
export function creationActivity(deps: TokenDeps, slug: string, cap: RestaurantCapability, type: ActivityType, hash: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || (raw as { ownerVerified?: unknown }).ownerVerified !== true) throw new BrowserManagementError('MANAGEMENT_NOT_AVAILABLE', 409);
  return publicActivity(deps, slug, cap, 0, type, hash, raw);
}
