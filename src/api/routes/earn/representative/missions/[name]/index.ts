import type { RouteHandler } from '../../../../../http';
import { ambassadorService } from '../../../../../../application/services/ambassador-service.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const mission = await ambassadorService.getMissionDetail(params.name!, user.id);
    return new Response(JSON.stringify(mission), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/missions/detail]', error);
    return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
};
