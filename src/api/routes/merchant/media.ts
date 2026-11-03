import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const title = formData.get('title') as string | null;
    const description = formData.get('description') as string | null;
    const merchantProfileId = formData.get('merchantProfileId') as string | null;

    if (!merchantProfileId || !/^[0-9a-f-]{36}$/i.test(merchantProfileId)) return Response.json({ error: 'merchant_profile_id_required' }, { status: 400 });

    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'file_required', message: 'Un fichier est requis' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'file_too_large', message: 'Max file size is 50 MB' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm'];
    if (!allowedTypes.includes(file.type) && !file.name.match(/\.(jpg|jpeg|png|gif|webp|pdf|mp3|wav|mp4|webm)$/i)) {
      return new Response(JSON.stringify({ error: 'file_invalid_type', message: 'Allowed: JPG, PNG, GIF, WebP, PDF, MP3, WAV, MP4, WebM' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const media = await merchantService.uploadMedia(user.id, merchantProfileId, {
      buffer,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
    }, title ?? undefined, description ?? undefined);

    return new Response(JSON.stringify(media), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if(error instanceof Error && (error.message.startsWith('INVALID_MEDIA')||error.message==='MERCHANT_ACCESS_DENIED'))return Response.json({error:error.message},{status:error.message==='MERCHANT_ACCESS_DENIED'?403:422});
    console.error('[merchant/media POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
