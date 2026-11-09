import type { RouteHandler } from '../../../http';
import { PointsKValuationError } from '../../../../application/services/points-k-valuation-service.ts';
import {
  authenticateSite, beneficiaryTerms, LinkPaySiteError, originKey, validateRouting, verifyInvoice,
} from '../../../../application/link-pay/frappe-site-routing.ts';
import { networkLinkService } from '../../../../application/link-pay/network-link-service.ts';

/**
 * Link Pay for an invoice of an authenticated Frappe site. The site sends the invoice, itself as
 * beneficiary and its network site; the API reads the invoice on the site and the beneficiary's
 * approved collection terms on the network site. No merchant profile is involved.
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const fail = (error: unknown) => {
  if (error instanceof LinkPaySiteError)
    return json({ error: error.code, ...(error.missing.length ? { missing: error.missing } : {}) }, error.status);
  if (error instanceof PointsKValuationError) return json({ error: error.code }, 422);
  const message = (error as Error)?.message;
  if (message === 'IDEMPOTENCY_KEY_REUSED' || message === 'INVOICE_CURRENCY_MISMATCH') return json({ error: message }, 409);
  return json({ error: 'LINK_PAY_UNAVAILABLE' }, 503);
};

export const POST: RouteHandler = async ({ request }) => {
  try {
    const site = authenticateSite(request);
    const attemptKey = request.headers.get('x-idempotency-key') || '';
    if (!/^[a-f0-9]{64}$/.test(attemptKey)) return json({ error: 'INVALID_IDEMPOTENCY_KEY' }, 400);
    const body = await request.json().catch(() => null);
    const routing = validateRouting(site, body?.beneficiarySite, body?.networkSite);
    const invoice = await verifyInvoice(site, body?.invoice);
    const terms = await beneficiaryTerms(routing.networkSite, routing.beneficiarySite);
    const description = typeof body?.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, 200) : 'Facture ' + invoice.name;
    const link = await networkLinkService.create({ site: site.key, originKey: originKey(site.key, attemptKey),
      invoice, terms, description, expiration: new Date(Date.now() + 7 * 86400000) });
    return json({ link, url: `/pay/l/${link.url_slug}` }, 201);
  } catch (error) {
    return fail(error);
  }
};

export const GET: RouteHandler = async ({ request, url }) => {
  try {
    const site = authenticateSite(request);
    const invoice = url.searchParams.get('invoice');
    if (!invoice) return json({ error: 'INVOICE_REFERENCE_INVALID' }, 400);
    return json({ links: await networkLinkService.listForSiteInvoice(site.key, invoice) });
  } catch (error) {
    return fail(error);
  }
};
