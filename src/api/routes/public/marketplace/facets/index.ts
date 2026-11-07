import type { RequestContext } from '../../../../http.ts';
import { json } from '../../../../../application/marketplace-transactions/http-handlers.ts';
import { defaultMarketplace, type publishedMarketplace } from '../../../../../application/services/published-marketplace.ts';

export const GET = async (_ctx: RequestContext, reader?: ReturnType<typeof publishedMarketplace>): Promise<Response> => {
 try {
  reader ??= await defaultMarketplace();
  return json(await reader.facets(),200);
 } catch { return json({error:'PROJECTION_UNAVAILABLE'},503); }
};
