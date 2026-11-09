import crypto from 'node:crypto';
import { z } from 'zod';
import { frappeSite, FrappeSiteError, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';

/**
 * Link Pay issued from a Frappe site: the site authenticates as itself, the API reads the invoice
 * on that site and chooses the collector server-side. Frappe never sends a merchant profile id.
 *
 * LINK_PAY_FRAPPE_SITES (JSON, deployment configuration):
 *   { "CONGO": { "tokenSha256": "<sha256 hex of the site token>",
 *                "companies": { "konektag congo": "<collecting merchant profile UUID>" } } }
 * The site origin and the API service token used to read its invoices come from the same
 * MARKETPLACE_FRAPPE_<SITE>_URL / _API_KEY / _API_SECRET as Marketplace routing.
 *
 * Each link keeps its origin: core_transaction_id = "frappe-site:<SITE>:<attempt key>" and
 * reference = invoice name. Two sites with the same invoice number never share a link.
 */

const SITE_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;
const siteConfig = z.object({
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  companies: z.record(z.string().min(1).max(140), z.string().uuid()),
}).strict();
const registry = z.record(z.string().regex(SITE_KEY), siteConfig);

export type LinkPaySiteConfig = z.infer<typeof siteConfig>;
export interface AuthenticatedSite { key: string; config: LinkPaySiteConfig }

export class LinkPaySiteError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export function loadLinkPaySites(env: NodeJS.ProcessEnv = process.env): Record<string, LinkPaySiteConfig> {
  const raw = env.LINK_PAY_FRAPPE_SITES;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LinkPaySiteError('LINK_PAY_SITES_INVALID', 503); }
  const result = registry.safeParse(parsed);
  if (!result.success) throw new LinkPaySiteError('LINK_PAY_SITES_INVALID', 503);
  return result.data;
}

/** X-Konektag-Frappe-Site + X-Konektag-Frappe-Token; only the token hash is configured. */
export function authenticateSite(request: Request, env: NodeJS.ProcessEnv = process.env): AuthenticatedSite {
  const key = request.headers.get('x-konektag-frappe-site') || '';
  const token = request.headers.get('x-konektag-frappe-token') || '';
  const sites = loadLinkPaySites(env);
  const config = SITE_KEY.test(key) && Object.hasOwn(sites, key) ? sites[key] : null;
  const actual = crypto.createHash('sha256').update(token).digest();
  const expected = Buffer.from(config?.tokenSha256 ?? '0'.repeat(64), 'hex');
  // Constant-time comparison even for an unknown site.
  if (!crypto.timingSafeEqual(actual, expected) || !config || token.length < 32)
    throw new LinkPaySiteError('FRAPPE_SITE_UNAUTHORIZED', 401);
  return { key, config };
}

export const originKey = (site: string, attemptKey: string) => `frappe-site:${site}:${attemptKey}`;

export interface VerifiedInvoice { name: string; company: string; beneficiary: string; amountMajor: string; currency: string }

/** Reads the invoice on the authenticated site; the collector follows the invoice company. */
export async function verifyInvoice(site: AuthenticatedSite, invoice: unknown,
  siteClient: (key: string) => FrappeSite = frappeSite): Promise<VerifiedInvoice> {
  if (typeof invoice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,139}$/.test(invoice))
    throw new LinkPaySiteError('INVOICE_REFERENCE_INVALID', 400);
  let doc: any;
  try {
    doc = await siteClient(site.key).get('Sales Invoice', invoice);
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED') throw new LinkPaySiteError('INVOICE_NOT_FOUND', 404);
    throw new LinkPaySiteError('FRAPPE_SITE_UNAVAILABLE', 503);
  }
  if (!doc || doc.name !== invoice) throw new LinkPaySiteError('INVOICE_NOT_FOUND', 404);
  if (doc.docstatus !== 1 || doc.is_return || doc.is_pos) throw new LinkPaySiteError('INVOICE_NOT_COLLECTABLE', 409);
  const beneficiary = Object.hasOwn(site.config.companies, doc.company) ? site.config.companies[doc.company] : null;
  if (!beneficiary) throw new LinkPaySiteError('COMPANY_NOT_ROUTED', 403);
  // Outstanding is in the receivable currency: only single-currency invoices are collected online.
  if (!doc.currency || doc.currency !== (doc.party_account_currency || doc.currency))
    throw new LinkPaySiteError('INVOICE_MULTI_CURRENCY', 409);
  const outstanding = Number(doc.outstanding_amount);
  if (!Number.isFinite(outstanding) || outstanding <= 0) throw new LinkPaySiteError('INVOICE_ALREADY_SETTLED', 409);
  return { name: doc.name, company: doc.company, beneficiary, amountMajor: String(doc.outstanding_amount), currency: doc.currency };
}
