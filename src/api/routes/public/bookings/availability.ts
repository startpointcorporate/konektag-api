import type { RequestContext } from '../../../http.ts';
import { availability, availabilityInput, commerceFailure, defaultCommerceDeps, type CommerceDeps } from '../../../../application/public-website/commerce.ts';
export const GET = async (ctx: RequestContext, deps: CommerceDeps = defaultCommerceDeps()): Promise<Response> => {
  const parsed = availabilityInput.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) return Response.json({ error: 'INVALID_PARAMETERS' }, { status: 422 });
  try { return Response.json(await availability(ctx, parsed.data, deps), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return commerceFailure(error); }
};
