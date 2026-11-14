import { z } from 'zod';
import type { RequestContext } from '../../../../../../../http.ts';
import { capability, defaultDeps, json, limited, unavailable, type TransactionDeps } from '../../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { FrappeSiteError } from '../../../../../../../../application/marketplace-transactions/frappe-site.ts';
const schema = z.object({
  reference: z.string().min(1).max(140), status: z.string().min(1).max(40), acceptanceStatus: z.literal('Accepted'),
  currency: z.string().regex(/^[A-Z]{3}$/), total: z.number().finite().nonnegative(), merchantName: z.string().min(1).max(200),
  lines: z.array(z.object({ itemCode: z.string().max(140), itemName: z.string().max(300), quantity: z.number().finite().positive(), unitPrice: z.number().finite().nonnegative(), amount: z.number().finite().nonnegative() })).max(200),
});
const headers = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
export const GET = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  const notFound = () => json({ error: 'ORDER_NOT_AVAILABLE' }, 404, headers);
  try {
    deps ??= await defaultDeps();
    const token = ctx.params.token;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound();
    const slug = ctx.params.slug!;
    const cap = await capability(deps, slug, 'restaurant');
    if (!cap) return notFound();
    const limit = await limited(deps, ctx, 'client-order', slug, token, 60, 30);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503, headers);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { ...headers, 'Retry-After': limit.retryAfter });
    const site = deps.site(cap.site);
    const value = await site.call('konektag_360.marketplace_orders.api.client_order', { slug, pos_profile: cap.posProfile, token });
    if (value?.error === 'ORDER_NOT_AVAILABLE') return notFound();
    if (value?.acceptanceStatus !== 'Accepted') return notFound();
    const out = schema.parse(value);
    if (['cancelled', 'canceled', 'rejected', 'merged'].includes(out.status.toLowerCase())) return notFound();
    // Site authority is resolved from allowlisted configuration, never input.
    if (out.reference === '.' || out.reference === '..' || /[\\/\x00-\x1f]/.test(out.reference)) throw new Error('Invalid native order reference');
    const origin = new URL(`https://${site.host}`);
    const qrUrl = new URL(`/app/pos-restaurant-order/${encodeURIComponent(out.reference)}`, origin).href;
    return json({ ...out, qrUrl }, 200, headers);
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && /\bTOO_MANY_REQUESTS\b/.test(error.serverMessage ?? '')) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { ...headers, 'Retry-After': '60' });
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && (error.httpStatus === 404 || error.serverMessage?.includes('ORDER_NOT_AVAILABLE'))) return notFound();
    const down = unavailable('client-order', error);
    return json({ error: down.error }, 503, headers);
  }
};
