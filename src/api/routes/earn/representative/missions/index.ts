import type { RouteHandler } from '../../../../http';
import { ambassadorService } from '../../../../../application/services/ambassador-service.ts';

export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const country = url.searchParams.get('country') || undefined;
    const city = url.searchParams.get('city') || undefined;
    const mission_type = url.searchParams.get('mission_type') || undefined;
    const activity_type = url.searchParams.get('activity_type') || undefined;
    const priority = url.searchParams.get('priority') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const missions = await ambassadorService.getAvailableMissions({
      country,
      city,
      mission_type: mission_type as any,
      activity_type: activity_type as any,
      priority: priority as any,
      limit,
    });

    return new Response(JSON.stringify(missions), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/missions]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
