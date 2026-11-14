import type { RequestContext } from '../../../../../../http.ts';
import { boundedRequest, capability, defaultDeps, json, limited, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { BrowserActivitiesInputSchema, BrowserManagementError, reconcileActivities } from '../../../../../../../application/marketplace-transactions/browser-management.ts';
const headers = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
export const POST = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    if (!ctx.request.headers.get('content-type')?.includes('application/json')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415, headers);
    const request = await boundedRequest(ctx.request, 65536);
    if (!request) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, headers);
    const body = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: 'INVALID_JSON' }, 400, headers);
    const parsed = BrowserActivitiesInputSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 400, headers);
    const slug = ctx.params.slug!;
    const cap = await capability(deps, slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404, headers);
    const limit = await limited(deps, ctx, 'browser-activities', slug, null, 120, 0);
    if (limit === 'unavailable') return json({ error: 'TRANSACTIONS_UNAVAILABLE' }, 503, headers);
    if (limit) return json({ error: 'TOO_MANY_REQUESTS' }, 429, { ...headers, 'Retry-After': limit.retryAfter });
    return json({ activities: await reconcileActivities(deps, slug, cap, parsed.data) }, 200, headers);
  } catch (error) {
    if (error instanceof BrowserManagementError) return json({ error: error.code }, error.status, { ...headers, ...(error.status === 429 ? { 'Retry-After': '60' } : {}) });
    const down = unavailable('browser-activities', error);
    return json({ error: down.error }, 503, { ...headers, ...down.headers });
  }
};
