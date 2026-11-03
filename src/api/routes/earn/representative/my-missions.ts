import type { RouteHandler } from '../../../http';
import { ambassadorService } from '../../../../application/services/ambassador-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profile = await ambassadorService.getAmbassadorProfile(user.id);
    if (!profile) {
      return new Response(JSON.stringify({ error: 'NOT_AMBASSADOR' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const missions = await ambassadorService.getMyMissions(user.id);
    return new Response(JSON.stringify(missions), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/my-missions]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
