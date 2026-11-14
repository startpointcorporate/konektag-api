import { z } from 'zod';
import { FrappeSiteError, type FrappeSite } from './frappe-site.ts';
import type { RestaurantCapability } from './merchant-capabilities.ts';
import { OrderModeError, TrackingUnavailable } from './restaurant-modes.ts';
const MODULE = 'konektag_360.marketplace_orders.api.';
export const trackedSummary = z.object({
  reference: z.string().min(1).max(140), createdAt: z.string().min(1).max(50),
  orderMode: z.enum(['pickup', 'reservation']), currency: z.string().regex(/^[A-Z]{3}$/), total: z.number().finite().nonnegative(),
  status: z.enum(['Open', 'Closed', 'Cancelled', 'Merged']), acceptanceStatus: z.enum(['Pending', 'Accepted', 'Rejected']),
  trackingStatus: z.enum(['Pending', 'Accepted', 'Preparing', 'Ready', 'Completed', 'Cancelled']),
});
const detail = trackedSummary.extend({
  merchantName: z.string().min(1).max(200),
  lines: z.array(z.object({ itemCode: z.string().max(140), itemName: z.string().max(300), quantity: z.number().finite().positive(), unitPrice: z.number().finite().nonnegative(), amount: z.number().finite().nonnegative() })).max(200),
});
async function call(site: FrappeSite, method: string, args: Record<string, unknown>) {
  try {
    const value = await site.call(MODULE + method, args);
    if (value?.error) throw new FrappeSiteError('SITE_REJECTED', 417, null, value.error);
    return value;
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED') {
      for (const code of ['TOO_MANY_REQUESTS', 'INVALID_LOOKUP', 'CAPABILITY_NOT_AVAILABLE'] as const) if (new RegExp('\\b' + code + '\\b').test(error.serverMessage ?? '')) throw new OrderModeError(code);
      if (/\bORDER_NOT_AVAILABLE\b/.test(error.serverMessage ?? '') || error.httpStatus === 404) throw new TrackingUnavailable();
    }
    throw error;
  }
}
export async function lookupOrders(site: FrappeSite, slug: string, cap: RestaurantCapability, search: { reference?: string; phone?: string; email?: string }) {
  const value = await call(site, 'order_lookup', { slug, pos_profile: cap.posProfile, ...search });
  // Rebuild minimal DTOs instead of ever returning native documents or contact data.
  return z.array(trackedSummary).max(20).parse(value?.orders);
}
export async function trackingOrder(site: FrappeSite, slug: string, cap: RestaurantCapability, reference: string) {
  return detail.parse(await call(site, 'tracking_order', { slug, pos_profile: cap.posProfile, reference }));
}
