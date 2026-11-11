import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { KonektagSiteError, konektagSiteErrorStatus } from '../../../application/shared/konektag-site.ts';
import { createPointsKQuotation, PointsKQuotationError, pointsKQuotationErrorStatus } from '../../../application/services/pay/points-k-quotation-service.ts';

const schema = z.object({
  // Country chosen by the user (residence is only the UI preselection), routed server-side.
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  // Maximum TTC budget, in major units of the currency.
  budget: z.number().finite().positive().max(1_000_000_000_000),
  // Item chosen by the UI (Points K for the current journey); never fixed here.
  itemCode: z.string().trim().min(1).max(140),
}).strict();

/**
 * Points K flow 1: draft ERPNext Quotation (quotation_to Lead) on the site of the
 * selected country, for the largest whole quantity whose rounded TTC total,
 * computed by ERPNext, fits the budget. No payment is created here.
 */
export const POST: RouteHandler = async ({ request, locals }) => {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_REQUEST' }, 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: 'INVALID_REQUEST', fields: parsed.error.issues.map(issue => issue.path.join('.')) }, 400);
  try {
    const result = await createPointsKQuotation({
      keycloakId: locals.user.keycloak_id,
      displayName: locals.user.username,
      ...parsed.data,
    });
    return json(result, result.quotation.created ? 201 : 200);
  } catch (error) {
    if (error instanceof KonektagSiteError) return json({ error: error.code }, konektagSiteErrorStatus(error));
    if (error instanceof PointsKQuotationError) {
      const status = pointsKQuotationErrorStatus(error.code);
      // Upstream messages stay in the logs; the caller gets the code and its own inputs.
      if (status >= 500) console.error('[points-k-quotation]', JSON.stringify({ code: error.code, ...error.detail }));
      const { message: _message, excType: _excType, httpStatus: _httpStatus, ...detail } = error.detail as Record<string, unknown>;
      return json({ error: error.code, ...(status < 500 ? detail : {}) }, status);
    }
    console.error('[points-k-quotation]', error instanceof Error ? error.message : error);
    return json({ error: 'POINTS_K_QUOTATION_FAILED' }, 500);
  }
};
