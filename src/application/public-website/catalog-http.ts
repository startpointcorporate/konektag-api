/**
 * HTTP plumbing of the public catalogue routes (src/api/routes/public/catalog/).
 * Frappe messages, hosts and keys are never forwarded: failures are coded only.
 */
import { FrappeSiteError, frappeSite, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import { CatalogConfigError, catalogSite, type CatalogSiteConfig } from './catalog-config.ts';
import { InvalidCursor, catalogSnapshot, etag, notModified } from './catalog-service.ts';
import { PublicSiteError, defaultPublicSiteResolver, publicSiteRequest, type PublicSiteContext, type PublicSiteResolver } from './site-context.ts';

export interface CatalogDeps {
  resolver: PublicSiteResolver;
  site: (key: string) => FrappeSite;
  config: (siteId: string) => CatalogSiteConfig | null;
  now: () => Date;
}

export const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const CACHED = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120', Vary: 'Origin, Accept-Encoding' };

export const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extra } });

/** A 200 with its entity tag, or a bodiless 304 when the browser already holds it. */
export function cachedJson(body: unknown, ifNoneMatch: string | null): Response {
  const tag = etag(body);
  if (notModified(ifNoneMatch, tag)) return new Response(null, { status: 304, headers: { ...CACHED, ETag: tag } });
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CACHED, ETag: tag } });
}

/** Resolves the site of the request and loads its catalogue snapshot. */
export async function openCatalog(deps: CatalogDeps, request: Request) {
  const context: PublicSiteContext = await deps.resolver.resolve(publicSiteRequest(new URL(request.url).searchParams, request.headers), 'catalog:read');
  const config = deps.config(context.siteId);
  if (!config) throw new PublicSiteError('SITE_NOT_FOUND', 404);
  const site = deps.site(context.frappeSiteKey);
  return { site, snapshot: await catalogSnapshot(context, site, config, deps.now()) };
}

export function failure(error: unknown): Response {
  if (error instanceof PublicSiteError) return json({ error: error.code }, error.httpStatus, error.httpStatus === 503 ? { 'Retry-After': '30' } : {});
  if (error instanceof InvalidCursor) return json({ error: 'INVALID_PARAMETERS' }, 422);
  if (error instanceof FrappeSiteError) {
    console.error('[public-catalog] Frappe', error.code, error.httpStatus, error.excType);
    return json({ error: 'CATALOG_UNAVAILABLE' }, 503, { 'Retry-After': '30' });
  }
  if (error instanceof CatalogConfigError) console.error('[public-catalog]', error.message);
  else console.error('[public-catalog] unexpected failure', error instanceof Error ? error.name : typeof error);
  return json({ error: 'CATALOG_UNAVAILABLE' }, 503, { 'Retry-After': '30' });
}

export function defaultCatalogDeps(
  env: NodeJS.ProcessEnv = process.env,
  io: { fetchImpl?: typeof fetch; database?: Parameters<typeof defaultPublicSiteResolver>[0]['database'] } = {},
): CatalogDeps {
  const config = (siteId: string) => catalogSite(siteId, env);
  return {
    resolver: defaultPublicSiteResolver({ env, database: io.database, isPublished: siteId => config(siteId) !== null }),
    site: key => frappeSite(key, env, io.fetchImpl),
    config,
    now: () => new Date(),
  };
}
