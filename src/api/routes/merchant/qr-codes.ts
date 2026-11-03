import type { RouteHandler } from '../../http';
import { qrService } from '../../../application/services/qr-service.ts';
import { merchantService } from '../../../application/merchant-service.ts';

export const GET: RouteHandler = async ({ locals, url }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const merchantProfileId = url.searchParams.get('merchantProfileId');
    if (!merchantProfileId) return Response.json({ error: 'merchantProfileId required' }, { status: 400 });
    const profile = await merchantService.getManagedProfile(user.id, merchantProfileId);
    const codes = await qrService.listMerchantQRCodes(profile.id);
    return new Response(JSON.stringify(codes), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[merchant/qr-codes]', error);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
