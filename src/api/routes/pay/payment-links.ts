import { getPublicPaymentLink } from '../../../application/services/public-payment-link-service.ts';
import type { RouteHandler } from '../../http';
import { LINK_PAY_MERCHANT_PROFILE_RETIRED } from '../../../application/services/payment-link-service.ts';
import { networkLinkService } from '../../../application/link-pay/network-link-service.ts';

/**
 * Link Pay consultation. Links are issued by Frappe sites (/api/integrations/frappe/payment-links)
 * and collected by their network site; issuing or listing links of a merchant profile is retired.
 */
const retired = () => Response.json({ error: LINK_PAY_MERCHANT_PROFILE_RETIRED }, { status: 410 });

export const POST: RouteHandler = async () => retired();

export const GET: RouteHandler = async ({ url, locals }) => {
  const slug = url.searchParams.get('slug');
  if (!slug) return retired();
  try {
    if (!locals.user) {
      const link = await getPublicPaymentLink(slug);
      return Response.json({ links: link ? [link] : [] }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const link = await networkLinkService.getBySlug(slug);
    if (!link) return Response.json({ links: [] }, { headers: { 'Cache-Control': 'no-store' } });
    const { checkoutIntentId: _internal, ...visible } = link;
    return Response.json({ links: [visible] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'LINK_UNAVAILABLE' }, { status: 500 });
  }
};
