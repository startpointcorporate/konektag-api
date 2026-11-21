import type { RequestContext } from '../../../http.ts';
import { bookingChangeInput, changeBooking, commerceFailure, defaultCommerceDeps, type CommerceDeps } from '../../../../application/public-website/commerce.ts';
export const PATCH = async (ctx: RequestContext, deps: CommerceDeps = defaultCommerceDeps()): Promise<Response> => {
  const parsed = bookingChangeInput.safeParse(await ctx.request.json().catch(() => null)); const name = ctx.params.name ?? '';
  if (!name || name.length > 140 || !parsed.success) return Response.json({ error: 'INVALID_PARAMETERS' }, { status: 422 });
  try { return Response.json(await changeBooking(ctx, name, parsed.data, deps), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return commerceFailure(error); }
};
