import type { RouteHandler } from '../../../http';
import { ambassadorService } from '../../../../application/services/ambassador-service.ts';
import { z } from 'zod';

const RegisterSchema = z.object({
  country: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  area: z.string().max(100).optional(),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const profile = await ambassadorService.registerRepresentative(user.id, parsed.data);
    return new Response(JSON.stringify(profile), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/register]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
