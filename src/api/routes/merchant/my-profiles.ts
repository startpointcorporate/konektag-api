import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profiles = await merchantService.getProfilesByUserId(user.id);
    return new Response(JSON.stringify(profiles), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[merchant/my-profiles]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
