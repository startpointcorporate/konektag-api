/**
 * Site context of the PUBLIC WEBSITE routes (catalogue, then contact and booking).
 *
 * The browser names either a public site id (`site=rocher-des-ages`) or a residence
 * country (`country=BE`); never a Frappe origin or key. The server resolves it to an
 * allowlisted Frappe site and checks, per operation, that the site publishes it.
 *
 * This port is the interface agreed with KON-107 (generic site/country routing). Until
 * its registry is published, the default resolver reuses the existing contracts:
 *   country -> resolveKonektagSite (FR/CG/LB, unchanged)
 *   site    -> resolveSlugSite (slug-level `site` of MARKETPLACE_TRANSACTION_MERCHANTS)
 * KON-107 only has to provide another PublicSiteResolver; routes do not change.
 */
import { KonektagSiteError, konektagSiteErrorStatus, resolveKonektagSite } from '../shared/konektag-site.ts';
import { isPublicSlug, resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';

export type PublicSiteKind = 'KONEKTAG' | 'CUSTOMER';
export type PublicSiteOperation = 'catalog.read';
export type PublicSiteRequest = { site?: string | null; country?: string | null };
export type PublicSiteContext = { siteId: string; kind: PublicSiteKind; frappeSiteKey: string };

export type PublicSiteErrorCode =
  | 'SITE_REQUIRED'
  | 'SITE_AND_COUNTRY_EXCLUSIVE'
  | 'SITE_INVALID'
  | 'SITE_NOT_FOUND'
  | 'RESIDENCE_COUNTRY_INVALID'
  | 'COUNTRY_RULE_NOT_FOUND'
  | 'SITE_ROUTING_UNAVAILABLE';

export class PublicSiteError extends Error {
  constructor(readonly code: PublicSiteErrorCode, readonly httpStatus: 400 | 404 | 422 | 503) {
    super(code);
    this.name = 'PublicSiteError';
  }
}

export interface PublicSiteResolver {
  resolve(input: PublicSiteRequest, operation: PublicSiteOperation): Promise<PublicSiteContext>;
}

const KONEKTAG_SLUGS = new Set(['konektag-fr', 'konektag-cg', 'konektag-lb']);
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/** Exactly one of `site` and `country`: a request naming both is ambiguous, not prioritised. */
export function publicSiteRequest(searchParams: URLSearchParams): PublicSiteRequest {
  const site = searchParams.get('site')?.trim() || null;
  const country = searchParams.get('country')?.trim() || null;
  if (site && country) throw new PublicSiteError('SITE_AND_COUNTRY_EXCLUSIVE', 400);
  if (!site && !country) throw new PublicSiteError('SITE_REQUIRED', 400);
  return { site, country };
}

/**
 * Interim resolver over the existing routing. `isPublished` is the per-operation
 * gate: a configured Frappe site that does not publish the operation is not found.
 */
export function defaultPublicSiteResolver(deps: {
  isPublished: (siteId: string, operation: PublicSiteOperation) => boolean;
  env?: NodeJS.ProcessEnv;
  database?: Queryable;
}): PublicSiteResolver {
  const env = deps.env ?? process.env;
  return {
    async resolve(input, operation) {
      let siteId: string;
      let frappeSiteKey: string | null;
      if (input.site) {
        if (!isPublicSlug(input.site)) throw new PublicSiteError('SITE_INVALID', 400);
        siteId = input.site;
        try { frappeSiteKey = resolveSlugSite(siteId, env); }
        catch { throw new PublicSiteError('SITE_ROUTING_UNAVAILABLE', 503); }
      } else {
        try {
          const route = await resolveKonektagSite(input.country ?? '', { env, database: deps.database });
          siteId = route.slug;
          frappeSiteKey = route.site;
        } catch (error) {
          if (!(error instanceof KonektagSiteError)) throw new PublicSiteError('SITE_ROUTING_UNAVAILABLE', 503);
          if (konektagSiteErrorStatus(error) === 422) throw new PublicSiteError(error.code as 'RESIDENCE_COUNTRY_INVALID' | 'COUNTRY_RULE_NOT_FOUND', 422);
          // Outside Konektag, ambiguous or unconfigured: configuration, not the visitor.
          throw new PublicSiteError('SITE_ROUTING_UNAVAILABLE', 503);
        }
      }
      // Unknown, unrouted and unpublished sites are indistinguishable to the browser.
      if (!frappeSiteKey || !deps.isPublished(siteId, operation)) throw new PublicSiteError('SITE_NOT_FOUND', 404);
      return { siteId, kind: KONEKTAG_SLUGS.has(siteId) ? 'KONEKTAG' : 'CUSTOMER', frappeSiteKey };
    },
  };
}
