/**
 * Frappe site of a public form (contact, opt-in).
 *
 * The browser names a site context (`siteId`) or a residence country (`country`);
 * the server resolves the tenant and its Frappe site through the shared router of
 * KON-107 (konektag-site.ts). The form code only sees this port.
 *
 * - `country` uses the Konektag country routing (FR/CG/LB).
 * - `siteId` is a `frappeSiteId` of the closed KONEKTAG_FRAPPE_SITE_REGISTRY, resolved
 *   as an anonymous call: the operation scope (`contact:write`, `optin:write`) must be
 *   in the entry's publicScopes and a browser Origin in its allowedOrigins. No free
 *   entry towards an arbitrary Frappe URL is ever accepted.
 */
import { resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';
import { frappeSite, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import {
  countryCodeFromInput, isKonektagCountry, KonektagSiteError, konektagFrappeSite, konektagSiteErrorStatus, logKonektagRoute,
  resolveFrappeSite, routeKonektagFlow, type KonektagSiteRoute,
} from '../shared/konektag-site.ts';

export type PublicFormOperation = 'contact' | 'optin';

export type PublicFormSite = {
  /** Stable owner of the data (Konektag entity slug or customer tenant). */
  tenantId: string;
  /** Allowlisted Frappe site key (MARKETPLACE_FRAPPE_<KEY>_*) of a country route, or the public frappeSiteId of a registry site. */
  siteId: string;
  kind: 'KONEKTAG' | 'CUSTOMER';
  frappe: FrappeSite;
  /** Mandatory Lead values of the site (owner, axis…), configured per entity. */
  leadDefaults: Record<string, string>;
};

export type SiteSelector = { siteId?: string; country?: string };

export class PublicFormSiteError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 422 | 503) {
    super(code);
    this.name = 'PublicFormSiteError';
  }
}

export interface PublicFormSites {
  /** Site of a browser request; `origin` is the Origin header, checked by the registry when it has one. */
  resolve(selector: SiteSelector, context: { operation: PublicFormOperation; origin: string | null }): Promise<PublicFormSite>;
  /** Site recorded in a signed token; the tenant must still own the site. */
  resolveRecorded(tenantId: string, siteId: string): Promise<PublicFormSite>;
}

function leadDefaults(country: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const owner = env[`KONEKTAG_MEETING_${country}_LEAD_OWNER`];
  const axis = env[`KONEKTAG_MEETING_${country}_DEFAULT_AXIS`];
  return { ...(owner ? { lead_owner: owner } : {}), ...(axis ? { custom_axis: axis } : {}) };
}

/** Registry scope of each operation; confirmation and unsubscribe belong to the opt-in. */
const scopes: Record<PublicFormOperation, string> = { contact: 'contact:write', optin: 'optin:write' };

function siteError(error: unknown): never {
  if (!(error instanceof KonektagSiteError)) throw error;
  // Unknown and disabled sites are indistinguishable to the browser.
  if (error.code === 'SITE_DISABLED') throw new PublicFormSiteError('SITE_NOT_FOUND', 404);
  throw new PublicFormSiteError(error.code, konektagSiteErrorStatus(error));
}

function client(siteId: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): FrappeSite {
  try { return frappeSite(siteId, env, fetchImpl); }
  catch { throw new PublicFormSiteError('KONEKTAG_SITE_NOT_CONFIGURED', 503); }
}

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export function konektagPublicFormSites(
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, database?: Queryable,
): PublicFormSites {
  const registrySite = (route: KonektagSiteRoute, operation: PublicFormOperation): PublicFormSite => {
    logKonektagRoute('public-form-' + operation, route);
    return {
      tenantId: route.slug, siteId: route.frappeSiteId!, kind: route.kind ?? 'KONEKTAG',
      frappe: konektagFrappeSite(route, env, fetchImpl),
      leadDefaults: route.kind === 'CUSTOMER' ? {} : leadDefaults(route.paymentCountry, env),
    };
  };
  const deps = { env, ...(database ? { database } : {}) };
  return {
    async resolve(selector, { operation, origin }) {
      const hasSite = typeof selector.siteId === 'string' && selector.siteId !== '';
      const hasCountry = typeof selector.country === 'string' && selector.country !== '';
      if (hasSite && hasCountry) throw new PublicFormSiteError('SITE_SELECTOR_CONFLICT', 400);
      if (!hasSite && !hasCountry) throw new PublicFormSiteError('SITE_SELECTOR_REQUIRED', 400);
      try {
        if (hasSite) {
          const route = await resolveFrappeSite(
            { siteId: selector.siteId }, { scope: scopes[operation], anonymous: true, ...(origin ? { origin } : {}) }, deps);
          return registrySite(route, operation);
        }
        const residenceCountry = countryCodeFromInput(selector.country!);
        if (!residenceCountry) throw new PublicFormSiteError('RESIDENCE_COUNTRY_INVALID', 422);
        const route = await routeKonektagFlow('public-form-' + operation, residenceCountry, deps);
        return {
          tenantId: route.slug, siteId: route.site, kind: 'KONEKTAG',
          frappe: konektagFrappeSite(route, env, fetchImpl), leadDefaults: leadDefaults(route.paymentCountry, env),
        };
      } catch (error) {
        siteError(error);
      }
    },
    async resolveRecorded(tenantId, siteId) {
      // A signed token names a registry site by its public id; the tenant must still own it and publish the opt-in.
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteId)) {
        try {
          const route = await resolveFrappeSite({ siteId }, { scope: scopes.optin, anonymous: true }, deps);
          if (route.slug !== tenantId) throw new PublicFormSiteError('SITE_NOT_FOUND', 404);
          return registrySite(route, 'optin');
        } catch (error) {
          siteError(error);
        }
      }
      const country = tenantId.startsWith('konektag-') ? tenantId.slice('konektag-'.length).toUpperCase() : '';
      if (!isKonektagCountry(country) || resolveSlugSite(tenantId, env) !== siteId)
        throw new PublicFormSiteError('SITE_NOT_FOUND', 404);
      return { tenantId, siteId, kind: 'KONEKTAG', frappe: client(siteId, env, fetchImpl), leadDefaults: leadDefaults(country, env) };
    },
  };
}
