import type { RequestContext } from '../../../../http';
import { cachedJson, defaultCatalogDeps, failure, json, openCatalog, type CatalogDeps } from '../../../../../application/public-website/catalog-http.ts';
import { catalogListQuery, listView } from '../../../../../application/public-website/catalog-service.ts';

// Public catalogue of one site (site=<public id> or country=<ISO>), live from ERPNext, cached 60 s.
export const GET = async (ctx: RequestContext, deps?: CatalogDeps): Promise<Response> => {
  const { site: _site, country: _country, ...filters } = Object.fromEntries(ctx.url.searchParams);
  const query = catalogListQuery.safeParse(filters);
  if (!query.success) return json({ error: 'INVALID_PARAMETERS' }, 422);
  try {
    deps ??= defaultCatalogDeps();
    const { snapshot } = await openCatalog(deps, ctx.url.searchParams);
    return cachedJson(listView(snapshot, query.data), ctx.request.headers.get('if-none-match'));
  } catch (error) {
    return failure(error);
  }
};
