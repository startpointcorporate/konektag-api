import type { RouteHandler } from '../../../../../http';
import { ambassadorService } from '../../../../../../application/services/ambassador-service.ts';
import { z } from 'zod';

const ReserveSchema = z.object({
  // Kept for the existing UI contract; identity always comes from the session.
  ambassador_name: z.string().optional(),
});

export const POST: RouteHandler = async ({ params, request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = ReserveSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const profile = await ambassadorService.getAmbassadorProfile(user.id);
    if (!profile) {
      return new Response(JSON.stringify({ error: 'NOT_AMBASSADOR', message: 'Vous devez devenir représentant d\'abord' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const mission = await ambassadorService.reserveMission(params.name!, user.id);
    return new Response(JSON.stringify(mission), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/reserve]', error);
    const status = error.message === 'NOT_AMBASSADOR' ? 403
      : ['MISSION_NOT_AVAILABLE', 'MISSION_LIMIT_REACHED'].includes(error.message) ? 409 : 500;
    return new Response(JSON.stringify({ error: error.message, message: error.message }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
