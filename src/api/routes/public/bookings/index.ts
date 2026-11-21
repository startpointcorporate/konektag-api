import type { RequestContext } from '../../../http.ts';
import { bookingInput, commerceFailure, createBooking, defaultCommerceDeps, type CommerceDeps } from '../../../../application/public-website/commerce.ts';
export const POST = async (ctx: RequestContext, deps: CommerceDeps = defaultCommerceDeps()): Promise<Response> => {
  const parsed = bookingInput.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'INVALID_PARAMETERS' }, { status: 422 });
  try { return Response.json(await createBooking(ctx, parsed.data, ctx.request.headers.get('idempotency-key') ?? '', deps), { status: 201, headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return commerceFailure(error); }
};
