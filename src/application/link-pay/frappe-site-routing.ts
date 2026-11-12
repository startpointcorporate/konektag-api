import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import { z } from 'zod';
import { frappeSite, FrappeSiteError, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import { countryCurrency } from '../services/country-currency-service.ts';

/** Merchant Frappe authenticates invoice issuance. Network identifiers are API routing keys;
 * they do not require an ERPNext origin or service account. Commercial terms live in the API.
 */
const SITE_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;
const siteConfig = z.object({
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  webhookSecret: z.string().min(32).max(256).optional(),
  network: z.boolean().optional(),
  merchants: z.record(z.string(), z.unknown()).optional(),
}).strict();
const registry = z.record(z.string().regex(SITE_KEY), siteConfig);

export type LinkPaySiteConfig = z.infer<typeof siteConfig>;
export interface AuthenticatedSite { key: string; config: LinkPaySiteConfig }

/** `missing` names the exact data the API or merchant integration operator must provide. */
export class LinkPaySiteError extends Error {
  constructor(readonly code: string, readonly status: number, readonly missing: string[] = []) { super(code); }
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

/** Where and how a site receives Link Pay webhooks; null when not deliverable. */
export function siteWebhook(site: string, env: NodeJS.ProcessEnv = process.env): { url: string; secret: string } | null {
  if (!SITE_KEY.test(site)) return null;
  const config = loadLinkPaySites(env)[site];
  const origin = env[`MARKETPLACE_FRAPPE_${site}_URL`];
  if (!config?.webhookSecret || !origin) return null;
  try {
    return { url: new URL('/api/method/konektag_360.link_pay.webhook.receive', origin).href, secret: config.webhookSecret };
  } catch { return null; }
}

/** The issuing site names itself as beneficiary and an allowlisted network site. */
export function validateRouting(site: AuthenticatedSite, beneficiarySite: unknown, networkSite: unknown,
  env: NodeJS.ProcessEnv = process.env) {
  if (beneficiarySite === undefined && networkSite === undefined)
    throw new LinkPaySiteError('LINK_PAY_CONTRACT_OUTDATED', 400, ['beneficiarySite', 'networkSite']);
  if (typeof beneficiarySite !== 'string' || !SITE_KEY.test(beneficiarySite))
    throw new LinkPaySiteError('BENEFICIARY_SITE_INVALID', 400, ['beneficiarySite']);
  if (typeof networkSite !== 'string' || !SITE_KEY.test(networkSite))
    throw new LinkPaySiteError('NETWORK_SITE_INVALID', 400, ['networkSite']);
  // The invoice is read on, and settled by, the site that issues the link.
  if (beneficiarySite !== site.key) throw new LinkPaySiteError('BENEFICIARY_SITE_MISMATCH', 403);
  const sites = loadLinkPaySites(env);
  if (!sites[networkSite]?.network) throw new LinkPaySiteError('NETWORK_SITE_NOT_ALLOWED', 403);
  const missing = [beneficiarySite].filter(s => !siteWebhook(s, env))
    .map(s => `LINK_PAY_FRAPPE_SITES.${s}.webhookSecret + MARKETPLACE_FRAPPE_${s}_URL`);
  if (missing.length) throw new LinkPaySiteError('SITE_WEBHOOK_NOT_CONFIGURED', 503, [...new Set(missing)]);
  return { beneficiarySite, networkSite };
}

export interface VerifiedInvoice { name: string; company: string; amountMajor: string; currency: string }

const siteCall = async <T>(read: () => Promise<T>, notFound: string, unavailable: string): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED') throw new LinkPaySiteError(notFound, 404);
    throw new LinkPaySiteError(unavailable, 503);
  }
};

/** Reads the invoice on the authenticated site. */
export async function verifyInvoice(site: AuthenticatedSite, invoice: unknown,
  siteClient: (key: string) => FrappeSite = frappeSite): Promise<VerifiedInvoice> {
  if (typeof invoice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,139}$/.test(invoice))
    throw new LinkPaySiteError('INVOICE_REFERENCE_INVALID', 400);
  const doc: any = await siteCall(() => siteClient(site.key).get('Sales Invoice', invoice), 'INVOICE_NOT_FOUND', 'FRAPPE_SITE_UNAVAILABLE');
  if (!doc || doc.name !== invoice) throw new LinkPaySiteError('INVOICE_NOT_FOUND', 404);
  if (doc.docstatus !== 1 || doc.is_return || doc.is_pos) throw new LinkPaySiteError('INVOICE_NOT_COLLECTABLE', 409);
  // Outstanding is in the receivable currency: only single-currency invoices are collected online.
  if (!doc.currency || doc.currency !== (doc.party_account_currency || doc.currency))
    throw new LinkPaySiteError('INVOICE_MULTI_CURRENCY', 409);
  const outstanding = Number(doc.outstanding_amount);
  if (!Number.isFinite(outstanding) || outstanding <= 0) throw new LinkPaySiteError('INVOICE_ALREADY_SETTLED', 409);
  return { name: doc.name, company: doc.company, amountMajor: String(doc.outstanding_amount), currency: doc.currency };
}

/** API-owned approved collection terms; link issuance freezes the fee rule. */
export interface BeneficiaryTerms {
  beneficiarySite: string; networkSite: string; name: string; country: string; currency: string;
  feeMode: 'PERCENTAGE' | 'EXEMPT'; feeRateBps: number;
  approvedBy: string; approvedAt: string; termsHash: string;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** Current approved terms from the API repository; never calls network ERPNext. */
export async function beneficiaryTerms(networkSite: string, beneficiarySite: string,
  db: Pick<import('pg').PoolClient, 'query'> = pool): Promise<BeneficiaryTerms> {
  const { rows: [raw] } = await db.query(`SELECT * FROM konektag.link_pay_beneficiary_terms
    WHERE network_site=$1 AND beneficiary_site=$2 FOR SHARE`, [networkSite, beneficiarySite]);
  if (!raw || typeof raw !== 'object' || raw.beneficiary_site !== beneficiarySite || raw.network_site !== networkSite)
    throw new LinkPaySiteError('BENEFICIARY_NOT_CONFIGURED', 404);
  const missing: string[] = [];
  if (!raw.enabled) missing.push('enabled');
  if (!raw.approved || !raw.approved_by || !raw.approved_on || !SHA256.test(raw.terms_hash || '')) missing.push('collection_approved');
  if (missing.length) throw new LinkPaySiteError('BENEFICIARY_NOT_APPROVED', 403, missing);
  let country: { code: string; currency: string } | null = null;
  try { country = countryCurrency(raw.country); } catch { missing.push('country'); }
  const feeMode = raw.fee_mode === 'Percentage' ? 'PERCENTAGE' : raw.fee_mode === 'Exempt' ? 'EXEMPT' : null;
  const feeRateBps = Number(raw.fee_rate_bps);
  if (!feeMode || !Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10000
    || (feeMode === 'PERCENTAGE' && feeRateBps === 0) || (feeMode === 'EXEMPT' && feeRateBps !== 0)) missing.push('fee_mode/fee_rate');
  // The network keeps collections for itself; a third party must be payable.
  if (beneficiarySite !== networkSite && !raw.payout_ready) missing.push('payout_method + payout details');
  if (typeof raw.beneficiary_name !== 'string' || !raw.beneficiary_name.trim()) missing.push('beneficiary_name');
  if (missing.length) throw new LinkPaySiteError('BENEFICIARY_TERMS_INCOMPLETE', 409, missing);
  return { beneficiarySite, networkSite, name: raw.beneficiary_name.trim().slice(0, 140), country: country!.code,
    currency: country!.currency, feeMode: feeMode!, feeRateBps,
    approvedBy: String(raw.approved_by).slice(0, 140), approvedAt: new Date(raw.approved_on).toISOString(), termsHash: raw.terms_hash };
}

/** Fee in minor units, half up; the network keeps the fee and owes the rest. */
export function splitAmount(grossMinor: number, feeRateBps: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0) throw new Error('INVALID_COMMERCIAL_AMOUNT');
  const fee = Number((BigInt(grossMinor) * BigInt(feeRateBps) + 5000n) / 10000n);
  return { gross: grossMinor, fee, net: grossMinor - fee };
}
