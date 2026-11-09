import type { RouteHandler } from '../../../http';
import { merchantActivationService } from '../../../../application/services/merchant-activation-service.ts';
import { paymentLinkService } from '../../../../application/services/payment-link-service.ts';
import { PointsKValuationError } from '../../../../application/services/points-k-valuation-service.ts';
import { authenticateSite, LinkPaySiteError, originKey, verifyInvoice } from '../../../../application/link-pay/frappe-site-routing.ts';

/**
 * Link Pay for invoices of an authenticated Frappe site. The site sends only the invoice name;
 * amount, currency and collector come from the invoice read on that site.
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error: unknown) => {
  if (error instanceof LinkPaySiteError) return json({ error: error.code }, error.status);
  if (error instanceof PointsKValuationError) return json({ error: error.code }, 422);
  const message = (error as Error)?.message;
  if (message === 'IDEMPOTENCY_KEY_REUSED') return json({ error: message }, 409);
  if (message === 'MERCHANT_CURRENCY_MISMATCH' || message === 'MERCHANT_NOT_FOUND') return json({ error: message }, 409);
  return json({ error: 'LINK_PAY_UNAVAILABLE' }, 503);
};

export const POST: RouteHandler = async ({ request }) => {
  try {
    const site = authenticateSite(request);
    const attemptKey = request.headers.get('x-idempotency-key') || '';
    if (!/^[a-f0-9]{64}$/.test(attemptKey)) return json({ error: 'INVALID_IDEMPOTENCY_KEY' }, 400);
    const body = await request.json().catch(() => null);
    const invoice = await verifyInvoice(site, body?.invoice);
    const activation = await merchantActivationService.requireMerchantApproved(invoice.beneficiary);
    if (!activation.ok) return json({ error: 'MERCHANT_NOT_ACTIVATED' }, 403);
    const description = typeof body?.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, 200) : 'Facture ' + invoice.name;
    const link = await paymentLinkService.create({
      merchantProfileId: invoice.beneficiary, amountMajor: invoice.amountMajor, currency: invoice.currency,
      description, reference: invoice.name, idempotencyKey: originKey(site.key, attemptKey),
      expiration: new Date(Date.now() + 7 * 86400000),
    });
    return json({ link: { ...link, origin: { site: site.key, invoice: invoice.name } }, url: `/pay/l/${link.url_slug}` }, 201);
  } catch (error) {
    return fail(error);
  }
};

export const GET: RouteHandler = async ({ request, url }) => {
  try {
    const site = authenticateSite(request);
    const invoice = url.searchParams.get('invoice');
    if (!invoice) return json({ error: 'INVOICE_REFERENCE_INVALID' }, 400);
    const links = await paymentLinkService.listForFrappeInvoice(site.key, invoice, Object.values(site.config.companies));
    return json({ links });
  } catch (error) {
    return fail(error);
  }
};
