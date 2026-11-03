import type { RouteHandler } from '../../http';
import { kycService } from '../../../application/services/kyc-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const status = await kycService.getStatus(user.id);
    return new Response(
      JSON.stringify(status),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[kyc/status]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
