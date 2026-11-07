import type { RequestContext } from '../../../../http.ts';
import { json } from '../../../../../application/marketplace-transactions/http-handlers.ts';
import { defaultMarketplace, marketplaceQuery, type publishedMarketplace } from '../../../../../application/services/published-marketplace.ts';

export const GET = async (ctx: RequestContext, reader?: ReturnType<typeof publishedMarketplace>): Promise<Response> => {
 const params = ctx.url.searchParams;
 const parsed = marketplaceQuery.safeParse(Object.fromEntries(params));
 if (!parsed.success || ['lat','lng','page','limit'].some(k=>params.has(k) && !params.get(k)?.trim())) return json({error:'INVALID_PARAMETERS'},422);
 try {
  reader ??= await defaultMarketplace();
  return json(await reader.list(parsed.data),200);
 } catch { return json({error:'PROJECTION_UNAVAILABLE'},503); }
};
