/**
 * Per-site publication of the public catalogue: PUBLIC_CATALOG_SITES (JSON, deployment
 * configuration), keyed by public site id. A site without an entry publishes nothing.
 *
 * Only settings of the catalogue live here: which ERPNext Price Lists are public, which
 * Item Groups and Item fields are shown. Site routing and credentials stay with the
 * site resolver (site-context.ts) and MARKETPLACE_FRAPPE_<SITE>_*.
 *
 *   { "rocher-des-ages": { "priceLists": ["Rocher des Âges — Tarifs commerciaux"] },
 *     "abm-demo": { "priceLists": ["ABM Demo — Tarifs de démonstration"], "abmResources": true } }
 */
import { z } from 'zod';

const fieldname = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);
const label = z.string().trim().min(1).max(140);
const host = z.string().regex(/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/);

/** Item fields that are internal by nature: never published, whatever the configuration says. */
const INTERNAL_FIELD = /(account|valuation|cost|purchase|supplier|margin|owner|modified|creation|docstatus|idx|lead_time|safety_stock|reorder|warehouse|tax|serial|batch|customer|commission|default)/;

const site = z.object({
  /** Selling Price Lists whose Item Prices are public, in display order. */
  priceLists: z.array(z.string().trim().min(1).max(140)).min(1).max(10),
  /** Optional allowlist of Item Groups; absent: every group. */
  itemGroups: z.array(z.string().trim().min(1).max(140)).min(1).max(100).optional(),
  /** Optional Check field of Item that must be set to publish it (for example custom_public_website). */
  publishedField: fieldname.optional(),
  /** Item fields shown as characteristics, besides unit, brand and variant attributes. */
  characteristicFields: z.array(z.object({ field: fieldname, label }).strict()).max(30).default([]),
  /** Hosts of virtual-tour links, in addition to the built-in providers. */
  virtualTourHosts: z.array(host).max(20).default([]),
  /** Links Items to konektag-abm resources (ABM Resource.selling_item, ABM Equipment Pool.item). */
  abmResources: z.boolean().default(false),
  /** Public https origin of the site's /files/, when the API reaches Frappe through an internal URL. */
  mediaOrigin: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username; }, 'https origin').optional(),
  /** IANA time zone deciding which price periods are current; default UTC. */
  timezone: z.string().min(3).max(64).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'time zone').default('UTC'),
}).strict().superRefine((value, ctx) => {
  for (const [i, { field }] of value.characteristicFields.entries())
    if (INTERNAL_FIELD.test(field)) ctx.addIssue({ code: 'custom', path: ['characteristicFields', i, 'field'], message: 'internal field' });
  if (value.publishedField && INTERNAL_FIELD.test(value.publishedField))
    ctx.addIssue({ code: 'custom', path: ['publishedField'], message: 'internal field' });
});

const registry = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160), site);

export type CatalogSiteConfig = z.infer<typeof site>;

export class CatalogConfigError extends Error {}

export function loadCatalogSites(env: NodeJS.ProcessEnv = process.env): Record<string, CatalogSiteConfig> {
  const raw = env.PUBLIC_CATALOG_SITES;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CatalogConfigError('PUBLIC_CATALOG_SITES is not JSON'); }
  const result = registry.safeParse(parsed);
  if (!result.success) throw new CatalogConfigError('PUBLIC_CATALOG_SITES is invalid');
  return result.data;
}

export function catalogSite(siteId: string, env: NodeJS.ProcessEnv = process.env): CatalogSiteConfig | null {
  const sites = loadCatalogSites(env);
  return Object.hasOwn(sites, siteId) ? sites[siteId] : null;
}
