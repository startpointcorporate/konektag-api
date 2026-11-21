/**
 * Site context of the PUBLIC WEBSITE routes (catalogue, then contact and booking).
 *
 * The browser names either a public site id (`site=rocher-des-ages`) or a residence
 * country (`country=BE`); never a Frappe origin or key. Both go through the shared
 * router of KON-107 (resolveFrappeSite): the country through payment_country_mappings
 * (FR/CG/LB unchanged), the site id through the closed KONEKTAG_FRAPPE_SITE_REGISTRY,
 * as an anonymous call that needs the operation in the entry's publicScopes and, when
 * the browser sends an Origin, that origin in its allowedOrigins.
 */
import { KonektagSiteError, konektagSiteErrorStatus, resolveFrappeSite } from '../shared/konektag-site.ts';

export type PublicSiteKind = 'KONEKTAG' | 'CUSTOMER';
export type PublicSiteScope = 'catalog:read' | 'quotation:write' | 'booking:read' | 'booking:write';
export type PublicSiteRequest = { site?: string | null; country?: string | null; origin?: string | null };
export type PublicSiteContext = { siteId: string; kind: PublicSiteKind; frappeSiteKey: string };

export type PublicSiteErrorCode =
  | 'SITE_SELECTOR_INVALID'
  | 'SITE_ACCESS_FORBIDDEN'
  | 'SITE_NOT_FOUND'
  | 'RESIDENCE_COUNTRY_INVALID'
  | 'COUNTRY_RULE_NOT_FOUND'
  | 'SITE_ROUTING_UNAVAILABLE';

export class PublicSiteError extends Error {
  constructor(readonly code: PublicSiteErrorCode, readonly httpStatus: 400 | 403 | 404 | 422 | 503) {
    super(code);
    this.name = 'PublicSiteError';
  }
}

export interface PublicSiteResolver {
  resolve(input: PublicSiteRequest, scope: PublicSiteScope): Promise<PublicSiteContext>;
}

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export function publicSiteRequest(searchParams: URLSearchParams, headers: Headers): PublicSiteRequest {
  return { site: searchParams.get('site'), country: searchParams.get('country'), origin: headers.get('origin') };
}

/**
 * Resolver over the shared router. `isPublished` is the operation's own gate: a routed
 * site that does not publish it is not found, like an unknown or disabled one.
 */
export function defaultPublicSiteResolver(deps: {
  isPublished: (siteId: string, scope: PublicSiteScope) => boolean;
  env?: NodeJS.ProcessEnv;
  database?: Queryable;
}): PublicSiteResolver {
  return {
    async resolve(input, scope) {
      let route;
      try {
        route = await resolveFrappeSite(
          { country: input.country ?? undefined, siteId: input.site ?? undefined },
          { scope, anonymous: true, origin: input.origin ?? undefined },
          { env: deps.env, database: deps.database },
        );
      } catch (error) {
        if (!(error instanceof KonektagSiteError)) throw new PublicSiteError('SITE_ROUTING_UNAVAILABLE', 503);
        const status = konektagSiteErrorStatus(error);
        if (status === 400) throw new PublicSiteError('SITE_SELECTOR_INVALID', 400);
        if (status === 403) throw new PublicSiteError('SITE_ACCESS_FORBIDDEN', 403);
        // Unknown and disabled sites are indistinguishable to the browser.
        if (status === 404) throw new PublicSiteError('SITE_NOT_FOUND', 404);
        if (status === 422) throw new PublicSiteError(error.code as 'RESIDENCE_COUNTRY_INVALID' | 'COUNTRY_RULE_NOT_FOUND', 422);
        // Outside Konektag, ambiguous or unconfigured: configuration, not the visitor.
        throw new PublicSiteError('SITE_ROUTING_UNAVAILABLE', 503);
      }
      // A country always leads to a Konektag entity, whose public id is its slug.
      const siteId = route.frappeSiteId ?? route.slug;
      if (!deps.isPublished(siteId, scope)) throw new PublicSiteError('SITE_NOT_FOUND', 404);
      return { siteId, kind: route.kind ?? 'KONEKTAG', frappeSiteKey: route.site };
    },
  };
}
