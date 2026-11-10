/**
 * Shared Frappe routing of the Konektag journeys.
 *
 *   residence country -> active rule of payment_country_mappings -> payment country
 *   -> slug konektag-<country> -> site key in MARKETPLACE_TRANSACTION_MERCHANTS
 *   -> MARKETPLACE_FRAPPE_<SITE>_URL / _API_KEY / _API_SECRET
 *
 * Example: BE -> FR -> konektag-fr -> EUROPE.
 * There is no fallback: a missing rule or site is an explicit error.
 */
import { resolveSlugSite } from '../marketplace-transactions/merchant-capabilities.ts';
import { frappeSite, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import countries from 'i18n-iso-countries';
import fr from 'i18n-iso-countries/langs/fr.json' with { type: 'json' };
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(fr);
countries.registerLocale(en);

export const konektagCountries = ['FR', 'CG', 'LB'] as const;
export type KonektagCountry = typeof konektagCountries[number];

export const konektagTimezones: Record<KonektagCountry, string> = {
  CG: 'Africa/Brazzaville', FR: 'Europe/Paris', LB: 'Asia/Beirut',
};

export type KonektagSiteErrorCode =
  | 'RESIDENCE_COUNTRY_INVALID'
  | 'COUNTRY_RULE_NOT_FOUND'
  | 'COUNTRY_RULE_AMBIGUOUS'
  | 'COUNTRY_RULE_OUTSIDE_KONEKTAG'
  | 'KONEKTAG_SITE_NOT_CONFIGURED';

export class KonektagSiteError extends Error {
  constructor(readonly code: KonektagSiteErrorCode, readonly detail: Record<string, string> = {}) {
    super(code);
    this.name = 'KonektagSiteError';
  }
}

export type KonektagSiteRoute = {
  residenceCountry: string;
  paymentCountry: KonektagCountry;
  slug: string;
  site: string;
  timezone: string;
};

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

async function defaultDatabase(): Promise<Queryable> {
  return (await import('../../infrastructure/database/pool.ts')).default;
}

export function isKonektagCountry(value: unknown): value is KonektagCountry {
  return typeof value === 'string' && (konektagCountries as readonly string[]).includes(value);
}

/** Reads the active rule for the residence country and returns the Frappe site that serves it. */
export async function resolveKonektagSite(
  residenceCountryInput: string,
  deps: { database?: Queryable; env?: NodeJS.ProcessEnv } = {},
): Promise<KonektagSiteRoute> {
  const residenceCountry = String(residenceCountryInput ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(residenceCountry)) throw new KonektagSiteError('RESIDENCE_COUNTRY_INVALID');
  const database = deps.database ?? await defaultDatabase();
  const { rows } = await database.query(
    `SELECT payment_country
     FROM konektag.payment_country_mappings
     WHERE detected_country = $1 AND status = 'ACTIVE'
       AND valid_from <= CURRENT_DATE
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`,
    [residenceCountry],
  );
  if (rows.length === 0) throw new KonektagSiteError('COUNTRY_RULE_NOT_FOUND', { residenceCountry });
  if (rows.length > 1) throw new KonektagSiteError('COUNTRY_RULE_AMBIGUOUS', { residenceCountry });
  const paymentCountry = String(rows[0].payment_country).toUpperCase();
  if (!isKonektagCountry(paymentCountry))
    throw new KonektagSiteError('COUNTRY_RULE_OUTSIDE_KONEKTAG', { residenceCountry, paymentCountry });
  const slug = 'konektag-' + paymentCountry.toLowerCase();
  const site = resolveSlugSite(slug, deps.env ?? process.env);
  if (!site) throw new KonektagSiteError('KONEKTAG_SITE_NOT_CONFIGURED', { residenceCountry, paymentCountry, slug });
  return { residenceCountry, paymentCountry, slug, site, timezone: konektagTimezones[paymentCountry] };
}

/** Authenticated client of the routed site; throws KONEKTAG_SITE_NOT_CONFIGURED without credentials. */
export function konektagFrappeSite(route: KonektagSiteRoute, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): FrappeSite {
  try {
    return frappeSite(route.site, env, fetchImpl);
  } catch {
    throw new KonektagSiteError('KONEKTAG_SITE_NOT_CONFIGURED', { paymentCountry: route.paymentCountry, slug: route.slug, site: route.site });
  }
}

/** One log line per routed call, so acceptance can check which site each journey used. */
export function logKonektagRoute(flow: string, route: KonektagSiteRoute): void {
  console.info('[konektag-site]', JSON.stringify({
    flow, residenceCountry: route.residenceCountry, paymentCountry: route.paymentCountry, slug: route.slug, site: route.site,
  }));
}

/** Maps an ISO code or a French/English country name to ISO 3166-1 alpha-2, or null. */
export function countryCodeFromInput(value: string): string | null {
  const text = String(value ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(text)) return countries.isValid(text.toUpperCase()) ? text.toUpperCase() : null;
  for (const locale of ['fr', 'en']) {
    const code = countries.getAlpha2Code(text, locale);
    if (code) return code.toUpperCase();
  }
  return null;
}

/** HTTP status of a routing error: an unserved country is the caller's input, the rest is configuration. */
export function konektagSiteErrorStatus(error: KonektagSiteError): 422 | 503 {
  return error.code === 'RESIDENCE_COUNTRY_INVALID' || error.code === 'COUNTRY_RULE_NOT_FOUND' ? 422 : 503;
}

/** Resolves the routed site and logs it; the single entry point of the four journeys. */
export async function routeKonektagFlow(flow: string, residenceCountry: string, deps?: Parameters<typeof resolveKonektagSite>[1]): Promise<KonektagSiteRoute> {
  const route = await resolveKonektagSite(residenceCountry, deps);
  logKonektagRoute(flow, route);
  return route;
}
