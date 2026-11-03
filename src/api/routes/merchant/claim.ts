import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const body = await request.json();
    const slug = body.slug;
    if (!slug) {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'slug requis' }), { status: 400 });
    }

    const result = await merchantService.claimProfile(user.id, slug);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404 });
    }
    console.error('[merchant/claim]', error);
    return new Response(JSON.stringify({ error: 'CLAIM_ERROR', message: error.message }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
