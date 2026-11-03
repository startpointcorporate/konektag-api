import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const requests = await merchantService.getAssignmentRequestsByUserId(user.id);
    return new Response(JSON.stringify(requests), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[merchant/my-assignment-requests]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
