/**
 * Frappe site of a public form (contact, opt-in).
 *
 * The browser names a site context (`siteId`) or a residence country (`country`);
 * the server resolves the tenant and its Frappe site. The form code only sees
 * this port, so the site registry of KON-107 replaces the binding below without
 * touching the contact and opt-in services.
 *
 * Current binding: `country` uses the published Konektag routing
 * (konektag-site.ts, FR/CG/LB). `siteId` is refused with
 * SITE_ROUTING_UNAVAILABLE until the site registry is published: no free entry
 * towards an arbitrary Frappe URL is ever accepted.
 */
import { resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';
import { frappeSite, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import {
  countryCodeFromInput, isKonektagCountry, KonektagSiteError, konektagFrappeSite, konektagSiteErrorStatus, routeKonektagFlow,
} from '../shared/konektag-site.ts';

export type PublicFormOperation = 'contact' | 'optin';

export type PublicFormSite = {
  /** Stable owner of the data (Konektag entity slug or customer tenant). */
  tenantId: string;
  /** Allowlisted Frappe site key (MARKETPLACE_FRAPPE_<KEY>_*). */
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

function client(siteId: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): FrappeSite {
  try { return frappeSite(siteId, env, fetchImpl); }
  catch { throw new PublicFormSiteError('KONEKTAG_SITE_NOT_CONFIGURED', 503); }
}

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export function konektagPublicFormSites(
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, database?: Queryable,
): PublicFormSites {
  return {
    async resolve(selector, { operation }) {
      const hasSite = typeof selector.siteId === 'string' && selector.siteId !== '';
      const hasCountry = typeof selector.country === 'string' && selector.country !== '';
      if (hasSite && hasCountry) throw new PublicFormSiteError('SITE_SELECTOR_CONFLICT', 400);
      if (!hasSite && !hasCountry) throw new PublicFormSiteError('SITE_SELECTOR_REQUIRED', 400);
      if (hasSite) throw new PublicFormSiteError('SITE_ROUTING_UNAVAILABLE', 503);
      const residenceCountry = countryCodeFromInput(selector.country!);
      if (!residenceCountry) throw new PublicFormSiteError('RESIDENCE_COUNTRY_INVALID', 422);
      try {
        const route = await routeKonektagFlow('public-form-' + operation, residenceCountry, { env, ...(database ? { database } : {}) });
        return {
          tenantId: route.slug, siteId: route.site, kind: 'KONEKTAG',
          frappe: konektagFrappeSite(route, env, fetchImpl), leadDefaults: leadDefaults(route.paymentCountry, env),
        };
      } catch (error) {
        if (error instanceof KonektagSiteError) throw new PublicFormSiteError(error.code, konektagSiteErrorStatus(error));
        throw error;
      }
    },
    async resolveRecorded(tenantId, siteId) {
      const country = tenantId.startsWith('konektag-') ? tenantId.slice('konektag-'.length).toUpperCase() : '';
      if (!isKonektagCountry(country) || resolveSlugSite(tenantId, env) !== siteId)
        throw new PublicFormSiteError('SITE_NOT_FOUND', 404);
      return { tenantId, siteId, kind: 'KONEKTAG', frappe: client(siteId, env, fetchImpl), leadDefaults: leadDefaults(country, env) };
    },
  };
}
