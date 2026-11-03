import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { qrcodeService } from '../../../application/qrcode-service.ts';
import { MerchantLocationRequiredError, MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { marketplaceSlug } from '../../../application/shared/marketplace/slug.ts';

export const GET: RouteHandler = async ({ locals, url }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const merchantProfileId = url.searchParams.get('merchantProfileId') ?? undefined;
    const { qrCodeUrl, publicPageUrl } = await merchantService.getQrCode(user.id, merchantProfileId);
    const profile = merchantProfileId ? await merchantService.getManagedProfile(user.id, merchantProfileId) : await merchantService.getProfile(user.id);
    const dataUrl = await qrcodeService.generateQrCodeDataUrl(publicPageUrl || 'https://konektag.io');
    const locale = (await pool.query('SELECT locale FROM konektag.users WHERE id=$1',[user.id])).rows[0]?.locale ?? 'fr';
    const city = marketplaceSlug(profile.city);
    const activities = [
      profile.restaurantProfile?.status === 'Published' ? 'Restaurant' : null,
      profile.hotelProfile?.status === 'Published' ? 'Hotel' : null,
      profile.commerceProfile?.status === 'Published' ? 'Commerce' : null,
    ].filter(Boolean) as string[];
    const activityQrs = await Promise.all(activities.map(async activity => {
      const url = '/' + locale + '/marketplace/' + city + '/' + activity + '/' + profile.slug + '/';
      return { activity, publicPageUrl: url, dataUrl: await qrcodeService.generateQrCodeDataUrl('https://konektag.io' + url) };
    }));

    return new Response(JSON.stringify({ qrCodeUrl, publicPageUrl, dataUrl, activityQrs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/qrcode]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const merchantProfileId = typeof body.merchantProfileId === 'string' ? body.merchantProfileId : undefined;
    const managedProfile = merchantProfileId ? await merchantService.getManagedProfile(user.id, merchantProfileId) : await merchantService.getProfile(user.id);
    const profile = { id: managedProfile.id };
    if (profile) {
      const activation = await merchantActivationService.requireMerchantApproved(profile.id);
      if (!activation.ok) return new Response(JSON.stringify({ error: activation.error }), { status: 403 });
    }

    const qrCode = await merchantService.generatePermanentQrCode(user.id, merchantProfileId);
    return new Response(JSON.stringify(qrCode), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    if (error instanceof MerchantLocationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, missing: error.missing, message: error.message }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[merchant/qrcode POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
