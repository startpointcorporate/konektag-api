import type { RouteHandler } from '../../../../http';
import { authenticateSite } from '../../../../../application/link-pay/frappe-site-routing.ts';
import { siteWebhookService } from '../../../../../application/link-pay/site-webhook-service.ts';
import { fail } from '../payment-links.ts';

/** A Frappe site reads, or asks again for, its Link Pay webhooks of one transaction. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RouteHandler = async ({ request, url }) => {
  try {
    const site = authenticateSite(request);
    const transactionId = url.searchParams.get('transactionId') || '';
    if (!UUID.test(transactionId)) return Response.json({ error: 'TRANSACTION_ID_INVALID' }, { status: 400 });
    return Response.json({ deliveries: await siteWebhookService.status(site.key, transactionId) });
  } catch (error) {
    return fail(error);
  }
};

export const POST: RouteHandler = async ({ request }) => {
  try {
    const site = authenticateSite(request);
    const body = await request.json().catch(() => null);
    if (!UUID.test(body?.transactionId || '')) return Response.json({ error: 'TRANSACTION_ID_INVALID' }, { status: 400 });
    return Response.json({ requeued: await siteWebhookService.redeliver(site.key, body.transactionId) });
  } catch (error) {
    return fail(error);
  }
};
