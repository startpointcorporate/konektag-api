import { getPublicPaymentLink } from '../../../application/services/public-payment-link-service.ts';
import type { RouteHandler } from '../../http';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import { paymentLinkService } from '../../../application/services/payment-link-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../application/merchant-service.ts';
import { PointsKValuationError } from '../../../application/services/points-k-valuation-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const body = await request.json();
    const { amount, currency, description, reference, expires_in_days, merchantProfileId } = body;
    // Link Pay conversion is performed on the merchant client. The service verifies the approved reference it used.
    // `amount` is entered in major units (10 EUR, 1000 XAF); the service converts it to minor units.
    const amountMajor = typeof amount === 'number' || typeof amount === 'string' ? String(amount) : '';
    if (!/^\d+(\.\d+)?$/.test(amountMajor) || Number(amountMajor) <= 0) {
      return new Response(JSON.stringify({ error: 'amount must be a positive decimal' }), { status: 400 });
    }
    if (typeof merchantProfileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(merchantProfileId)) return new Response(JSON.stringify({ error: 'merchantProfileId required' }), { status: 400 });
    const { rows: [profile] } = await pool.query(`SELECT id, user_id, status FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [merchantProfileId]);
    if (!profile) return new Response(JSON.stringify({ error: 'MERCHANT_NOT_FOUND' }), { status: 404 });
    try { await merchantService.requireOwnerOrManager(merchantProfileId, user.id); } catch { return new Response(JSON.stringify({ error: 'MERCHANT_SCOPE_FORBIDDEN' }), { status: 403 }); }
    const activation = await merchantActivationService.requireMerchantApproved(merchantProfileId);
    if (!activation.ok) return new Response(JSON.stringify({ error: 'MERCHANT_NOT_ACTIVATED', reason: activation.error }), { status: 403 });
    const link = await paymentLinkService.create({ merchantProfileId, amountMajor, currency,
      description, reference, expiration: new Date(Date.now() + (expires_in_days || 7) * 86400000) });

    return new Response(JSON.stringify({ link, url: `/pay/l/${link.url_slug}` }), { status: 201 });
  } catch (err: any) {
    if (err instanceof PointsKValuationError) return new Response(JSON.stringify({ error: err.code }), { status: 422 });
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};

export const GET: RouteHandler = async ({ url, locals }) => {
  const slug = url.searchParams.get('slug');
  if (slug) {
    try {
      if (!locals.user) {
        const link = await getPublicPaymentLink(slug);
        return Response.json({ links: link ? [link] : [] }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const link = await paymentLinkService.get(slug);
      const links = link ? [link] : [];
      return new Response(JSON.stringify({ links }), { status: 200 });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: locals.user ? err.message : 'LINK_UNAVAILABLE' }), { status: 500 });
    }
  }

  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const merchantProfileId = url.searchParams.get('merchantProfileId');
    if (merchantProfileId) {
      try { await merchantService.requireOwnerOrManager(merchantProfileId, user.id); }
      catch { return Response.json({ error: 'MERCHANT_SCOPE_FORBIDDEN' }, { status: 403 }); }
    }
    const links = await paymentLinkService.listForUser(user.id);
    const scopedLinks = merchantProfileId ? links.filter((link: any) => link.merchant === merchantProfileId) : links;
    return new Response(JSON.stringify({ links: scopedLinks }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
