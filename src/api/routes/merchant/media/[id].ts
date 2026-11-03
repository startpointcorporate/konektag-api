import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';

export const DELETE: RouteHandler = async ({ params, locals, url }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'media_id_required' }), { status: 400 });

  const merchantProfileId = url.searchParams.get('merchantProfileId');
  if (!merchantProfileId) return Response.json({ error: 'merchant_profile_id_required' }, { status: 400 });

  try {
    await merchantService.deleteMedia(user.id, merchantProfileId, id);
    return new Response(null, { status: 204 });
  } catch (error: any) {
    console.error('[merchant/media DELETE]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const PUT: RouteHandler = async ({ params, request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'media_id_required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  try {
    const body = await request.json();
    const merchantProfileId = body?.merchantProfileId;
    if (!merchantProfileId) return Response.json({ error: 'merchant_profile_id_required' }, { status: 400 });
    const { merchantProfileId: _profileId, ...patch } = body;
    await merchantService.updateMedia(user.id, merchantProfileId, id, patch);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[merchant/media PUT]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
