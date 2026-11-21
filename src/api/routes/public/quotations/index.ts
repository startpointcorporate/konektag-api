import type { RequestContext } from '../../../http.ts';
import { commerceFailure, createQuotation, defaultCommerceDeps, quotationInput, type CommerceDeps } from '../../../../application/public-website/commerce.ts';
export const POST = async (ctx: RequestContext, deps: CommerceDeps = defaultCommerceDeps()): Promise<Response> => {
  const parsed = quotationInput.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'INVALID_PARAMETERS' }, { status: 422 });
  try { return Response.json(await createQuotation(ctx, parsed.data, deps), { status: 201, headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return commerceFailure(error); }
};
