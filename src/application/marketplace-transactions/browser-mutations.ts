import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext } from '../../api/http.ts';
import { boundedRequest, capability, defaultDeps, IDEMPOTENCY_KEY, json, limited, unavailable, type TransactionDeps } from './http-handlers.ts';
import { BrowserManagementError, ManagementTokenSchema, browserCall, publicActivity, readManagement, type ActivityType } from './browser-management.ts';
import { fingerprint } from './replay.ts';
import { quoteCart } from './restaurant-orders.ts';
const base = { managementToken: ManagementTokenSchema, expectedVersion: z.string().min(1).max(128) };
export const CancelReservationSchema = z.object({ ...base, action: z.literal('cancel') }).strict();
export const UpdateOrderSchema = z.object({ ...base,
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(z.object({ itemCode: z.string().min(1).max(140), quantity: z.number().int().min(1).max(50), unitPrice: z.number().finite().min(0).max(100_000_000) }).strict()).min(1).max(40),
  customer: z.object({ name: z.string().trim().min(2).max(120).regex(/^[^<>{}\n\r]+$/), phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/), email: z.string().trim().toLowerCase().email().max(254).optional() }).strict().optional(),
  note: z.string().max(500).optional(),
}).strict();
const headers = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
export async function mutateBrowserActivity(ctx: RequestContext, type: ActivityType, deps?: TransactionDeps): Promise<Response> {
  let refreshQuote: (() => ReturnType<typeof quoteCart>) | undefined;
  try {
    deps ??= await defaultDeps();
    const key = ctx.request.headers.get('idempotency-key') ?? ctx.request.headers.get('x-idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) return json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400, headers);
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415, headers);
    const request = await boundedRequest(ctx.request, 65536);
    if (!request) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, headers);
    const body = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400, headers);
    const parsed = type === 'order' ? UpdateOrderSchema.safeParse(body) : CancelReservationSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 400, headers);
    const slug = ctx.params.slug!;
    const cap = await capability(deps, slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404, headers);
    const claims = readManagement(deps, slug, cap, parsed.data.managementToken, type);
    if (claims.expires <= deps.now().getTime()) throw new BrowserManagementError('MANAGEMENT_TOKEN_EXPIRED', 410);
    const limit = await limited(deps, ctx, 'browser-' + type + '-mutation', slug, claims.ownerHash, 60, 20);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503, headers);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { ...headers, 'Retry-After': limit.retryAfter });
    const { managementToken, ...business } = parsed.data;
    const args: Record<string, unknown> = { slug, pos_profile: cap.posProfile, reference: claims.reference, owner_hash: claims.ownerHash,
      expected_version: parsed.data.expectedVersion, mutation_key: createHash('sha256').update(JSON.stringify([type, slug, cap.site, cap.posProfile, claims.reference, key])).digest('hex'), mutation_fingerprint: fingerprint({ type, reference: claims.reference, ...business }) };
    if (type === 'order') {
      const input = UpdateOrderSchema.parse(parsed.data);
      Object.assign(args, { currency: input.currency, lines: input.lines.map(line => ({ item_code: line.itemCode, qty: line.quantity, price: line.unitPrice })),
        ...(input.customer !== undefined ? { customer: input.customer } : {}), ...(input.note !== undefined ? { note: input.note } : {}) });
      refreshQuote = () => quoteCart(deps!.site(cap.site), cap, input.lines, input.currency, deps!.now().toISOString().slice(0, 10));
    }
    const result = await browserCall(deps, cap, type === 'order' ? 'browser_update_order' : 'browser_cancel_reservation', args);
    const activity = publicActivity(deps, slug, cap, 0, type, claims.ownerHash, result, { token: managementToken, claims });
    return json({ activity, replayed: result.replayed === true }, 200, headers);
  } catch (error) {
    if (error instanceof BrowserManagementError) {
      if (refreshQuote && ['PRICE_CHANGED', 'ITEM_UNAVAILABLE'].includes(error.code)) {
        try { return json({ error: error.code, quote: await refreshQuote() }, 409, headers); } catch { /* retain atomic business refusal */ }
      }
      return json({ error: error.code }, error.status, { ...headers, ...(error.status === 429 ? { 'Retry-After': '60' } : {}) });
    }
    const down = unavailable('browser-mutation', error);
    return json({ error: down.error }, 503, { ...headers, ...down.headers });
  }
}
