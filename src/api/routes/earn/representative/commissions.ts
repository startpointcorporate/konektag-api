import type { RouteHandler } from '../../../http';
import { ambassadorService } from '../../../../application/services/ambassador-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const commissions = await ambassadorService.getCommissions(user.id);
    return new Response(JSON.stringify(commissions), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/commissions]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
