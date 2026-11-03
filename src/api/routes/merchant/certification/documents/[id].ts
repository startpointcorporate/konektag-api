import type { RouteHandler } from '../../../../http';
import { merchantService } from '../../../../../application/merchant-service.ts';

export const DELETE: RouteHandler = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const docId = params.id;
  if (!docId) return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });

  try {
    await merchantService.deleteKybDocument(user.id, docId);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[merchant/certification/documents DELETE]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 422 });
  }
};
