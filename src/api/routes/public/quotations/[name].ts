import type { RequestContext } from '../../../http.ts';
import { commerceFailure, defaultCommerceDeps, getQuotation, type CommerceDeps } from '../../../../application/public-website/commerce.ts';
export const GET = async (ctx: RequestContext, deps: CommerceDeps = defaultCommerceDeps()): Promise<Response> => {
  const name = ctx.params.name ?? ''; const token = ctx.url.searchParams.get('accessToken') ?? '';
  if (!name || name.length > 140 || !token) return Response.json({ error: 'INVALID_PARAMETERS' }, { status: 422 });
  try { return Response.json(await getQuotation(ctx, name, token, deps), { headers: { 'Cache-Control': 'no-store' } }); } catch (error) { return commerceFailure(error); }
};
