import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { publicEstablishment } from '../../../application/services/public-merchant.ts';
import { query } from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  const { slug } = params;
  if (!slug || slug === 'search' || slug === 'scan' || slug === 'qr-codes') {
    return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  try {
    const profile = await merchantService.getProfileBySlug(slug);
    const live = await publicEstablishment(slug);
    if (!profile && !live) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Merchant not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let result = (profile || {}) as any;
    result.isCurrentUserOwner = false;

    try {
      const user = locals.user;
      if (user) {
        const { rows: [owner] } = await query(
          `SELECT 1
           FROM konektag.merchant_memberships
           WHERE merchant_profile_id = $1
             AND user_id = $2
             AND status = 'active'
             AND role IN ('owner', 'manager')
             AND removed_at IS NULL
           LIMIT 1`,
          [profile?.id??live?.merchant.id, user.id],
        );
        result.isCurrentUserOwner = Boolean(owner) || profile?.userId === user.id;
      }
    } catch {}

    if (!result.isCurrentUserOwner) {
      if (!live) return Response.json({error:'NOT_FOUND'},{status:404,headers:{'Cache-Control':'no-store'}});
      const publicMerchant = live.merchant;
      // Public API never serializes the working draft, owner identifiers or KYB/payment data.
      const fields = ['id','slug','businessName','logoUrl','coverImageUrl','shortDescription','longDescription',
        'address','city','country','neighborhood','phone','email','websiteUrl','latitude','longitude',
        'seoTitle','seoDescription','seoCanonicalUrl','ogTitle','ogDescription','ogImageUrl'];
      result = Object.fromEntries(fields.map(key => [key, publicMerchant[key]]));
      result.isCurrentUserOwner = false;
      const activities = live.activities;
      for (const activity of activities) {
        const key = ({ Restaurant:'restaurantProfile', Hotel:'hotelProfile', Commerce:'commerceProfile' } as Record<string,string>)[activity.activity_code];
        if (key) result[key] = activity.snapshot.activity;
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error: any) {
    console.error('[merchant/[slug]]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
