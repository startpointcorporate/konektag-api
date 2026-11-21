import type { RequestContext } from '../../../../http';
import { cachedJson, defaultCatalogDeps, failure, json, openCatalog, type CatalogDeps } from '../../../../../application/public-website/catalog-http.ts';
import { catalogDetailQuery, detailView, findEntry, variantAttributes } from '../../../../../application/public-website/catalog-service.ts';

// Public sheet of one catalogue entry, by ERPNext item code or public slug.
export const GET = async (ctx: RequestContext, deps?: CatalogDeps): Promise<Response> => {
  const ref = ctx.params.ref ?? '';
  const { site: _site, country: _country, ...filters } = Object.fromEntries(ctx.url.searchParams);
  const query = catalogDetailQuery.safeParse(filters);
  if (!ref || ref.length > 140 || !query.success) return json({ error: 'INVALID_PARAMETERS' }, 422);
  try {
    deps ??= defaultCatalogDeps();
    const { site, snapshot } = await openCatalog(deps, ctx.url.searchParams);
    // Unpublished, disabled and internal Items are indistinguishable from absent ones.
    const entry = findEntry(snapshot, ref);
    if (!entry) return json({ error: 'ITEM_NOT_FOUND' }, 404);
    const body = detailView(snapshot, entry, await variantAttributes(site, snapshot, entry), query.data.currency);
    return cachedJson(body, ctx.request.headers.get('if-none-match'));
  } catch (error) {
    return failure(error);
  }
};
