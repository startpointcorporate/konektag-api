import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EncryptionService } from '../../infrastructure/adapters/encryption.ts';
import { FrappeSiteError, type FrappeSite } from './frappe-site.ts';
import type { RestaurantCapability } from './merchant-capabilities.ts';
import type { TransactionDeps } from './http-handlers.ts';
import type { OrderInput, RecordedOrder } from './restaurant-orders.ts';
const MODULE = 'konektag_360.marketplace_orders.api.';
export const RESERVATION_SELECTION_TTL_MS = 15 * 60_000;
const selectionSchema = z.object({ purpose: z.literal('marketplace-reservation-selection-v1'), slug: z.string(), site: z.string(), posProfile: z.string(), reference: z.string().min(1).max(140), expires: z.number().int() }).strict();
const summarySchema = z.object({ reference: z.string().min(1).max(140), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/), partySize: z.number().int().min(1).max(500) }).strict();
export type ReservationSummary = z.infer<typeof summarySchema>;
export interface OrderModes { pickup: { enabled: boolean; available: boolean }; reservation: { enabled: boolean } }
export class OrderModeError extends Error {
  constructor(readonly code: 'PICKUP_UNAVAILABLE' | 'RESERVATION_INELIGIBLE' | 'RESERVATION_SELECTION_EXPIRED' | 'INVALID_RESERVATION_SELECTION' | 'IDEMPOTENCY_KEY_REUSED' | 'INVALID_ORDER' | 'PRICE_CHANGED' | 'ITEM_UNAVAILABLE' | 'CURRENCY_MISMATCH' | 'INVALID_LOOKUP' | 'CAPABILITY_NOT_AVAILABLE' | 'TOO_MANY_REQUESTS') { super(code); }
}
function codec(env: NodeJS.ProcessEnv) {
  const key = Buffer.from(env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('Selection encryption unavailable');
  return new EncryptionService(key);
}
export function issueSelection(deps: Pick<TransactionDeps, 'env' | 'now'>, slug: string, cap: RestaurantCapability, reference: string) {
  return codec(deps.env).encrypt(JSON.stringify({ purpose: 'marketplace-reservation-selection-v1', slug, site: cap.site, posProfile: cap.posProfile, reference, expires: deps.now().getTime() + RESERVATION_SELECTION_TTL_MS })).toString('base64url');
}
export function readSelection(deps: Pick<TransactionDeps, 'env' | 'now'>, slug: string, cap: RestaurantCapability, token: string) {
  const encryption = codec(deps.env);
  try {
    if (!/^[A-Za-z0-9_-]{40,2048}$/.test(token)) throw new Error();
    const value = selectionSchema.parse(JSON.parse(encryption.decrypt(Buffer.from(token, 'base64url'))));
    if (value.slug !== slug || value.site !== cap.site || value.posProfile !== cap.posProfile) throw new Error();
    return { reference: value.reference, valid: value.expires > deps.now().getTime() };
  } catch { throw new OrderModeError('INVALID_RESERVATION_SELECTION'); }
}
export async function orderModes(site: FrappeSite, slug: string, cap: RestaurantCapability): Promise<OrderModes> {
  const disabled = { pickup: { enabled: false, available: false }, reservation: { enabled: false } };
  try {
    const value = await site.call(MODULE + 'options', { slug, pos_profile: cap.posProfile });
    const parsed = z.object({ pickup: z.object({ enabled: z.boolean(), available: z.boolean() }), reservation: z.object({ enabled: z.boolean() }) }).safeParse(value?.orderModes ?? value);
    return parsed.success ? parsed.data : disabled;
  } catch { return disabled; }
}
export async function lookupReservations(site: FrappeSite, slug: string, cap: RestaurantCapability, search: { reference?: string; phone?: string }): Promise<ReservationSummary[]> {
  let value: any;
  try { value = await site.call(MODULE + 'lookup', { slug, pos_profile: cap.posProfile, ...search }); }
  catch (error) { throwBusinessError(error); throw error; }
  if (value?.error) throwBusinessError(new FrappeSiteError('SITE_REJECTED', 417, null, value.error));
  return z.array(summarySchema).max(20).parse(value?.reservations);
}
export function durableOrderKey(slug: string, cap: RestaurantCapability, key: string) {
  return createHash('sha256').update(JSON.stringify([slug, cap.site, cap.posProfile, cap.channel, key])).digest('hex');
}
const errorCodes = ['PICKUP_UNAVAILABLE', 'RESERVATION_INELIGIBLE', 'RESERVATION_SELECTION_EXPIRED', 'IDEMPOTENCY_KEY_REUSED', 'INVALID_ORDER', 'PRICE_CHANGED', 'ITEM_UNAVAILABLE', 'CURRENCY_MISMATCH', 'INVALID_LOOKUP', 'CAPABILITY_NOT_AVAILABLE', 'TOO_MANY_REQUESTS'] as const;
function throwBusinessError(error: unknown): void {
  if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED') {
    for (const code of errorCodes) if (new RegExp('\\b' + code + '\\b').test(error.serverMessage ?? '')) throw new OrderModeError(code);
  }
}
export async function placeModeOrder(site: FrappeSite, slug: string, cap: RestaurantCapability, key: string, print: string, input: OrderInput, mode: 'pickup' | 'reservation', reference: string | undefined, valid: boolean): Promise<RecordedOrder & { orderMode: 'pickup' | 'reservation'; reservation: ReservationSummary | null; replayed?: boolean }> {
  let value: any;
  try {
    value = await site.call(MODULE + 'checkout', {
      slug, pos_profile: cap.posProfile, request_key: durableOrderKey(slug, cap, key), request_fingerprint: print,
      order_mode: mode, reservation_reference: reference ?? '', selection_valid: valid, channel: cap.channel,
      currency: input.currency, lines: input.lines.map(l => ({ item_code: l.itemCode, qty: l.quantity, price: l.unitPrice })),
      customer: input.customer, note: input.note ?? '',
    });
  } catch (error) {
    throwBusinessError(error);
    throw error;
  }
  if (value?.error && errorCodes.includes(value.error)) throw new OrderModeError(value.error);
  const parsed = z.object({ reference: z.string().min(1).max(140), status: z.string().max(40), currency: z.string().regex(/^[A-Z]{3}$/), total: z.number().finite().nonnegative(), lines: z.array(z.object({ itemCode: z.string(), itemName: z.string(), quantity: z.number().positive(), unitPrice: z.number().nonnegative(), amount: z.number().nonnegative() })), orderMode: z.enum(['pickup', 'reservation']), reservation: summarySchema.nullable(), replayed: z.boolean().optional() }).parse(value);
  if (parsed.orderMode !== mode || (mode === 'reservation' ? parsed.reservation?.reference !== reference : parsed.reservation !== null)) throw new Error('Invalid recorded association');
  return parsed;
}

export const ORDER_TRACKING_TTL_MS = 24 * 60 * 60_000;
const trackingTokenSchema = selectionSchema.extend({ purpose: z.literal('marketplace-order-tracking-v1') });
export class TrackingUnavailable extends Error { constructor() { super('ORDER_NOT_AVAILABLE'); } }
export function issueTracking(deps: Pick<TransactionDeps, 'env' | 'now'>, slug: string, cap: RestaurantCapability, reference: string) {
  return codec(deps.env).encrypt(JSON.stringify({ purpose: 'marketplace-order-tracking-v1', slug, site: cap.site, posProfile: cap.posProfile, reference, expires: deps.now().getTime() + ORDER_TRACKING_TTL_MS })).toString('base64url');
}
export function readTracking(deps: Pick<TransactionDeps, 'env' | 'now'>, slug: string, cap: RestaurantCapability, token: string) {
  const encryption = codec(deps.env);
  try {
    if (!/^[A-Za-z0-9_-]{44,2048}$/.test(token)) throw new Error();
    const value = trackingTokenSchema.parse(JSON.parse(encryption.decrypt(Buffer.from(token, 'base64url'))));
    if (value.slug !== slug || value.site !== cap.site || value.posProfile !== cap.posProfile || value.expires <= deps.now().getTime()) throw new Error();
    return value.reference;
  } catch { throw new TrackingUnavailable(); }
}
