import type { RouteHandler } from '../../../http';
import { agentService } from '../../../../application/services/agent-service.ts';
import { z } from 'zod';

const ApplySchema = z.object({
  merchant_profile_id: z.string().uuid().optional(),
  business_name: z.string().min(1).max(200),
  manager_name: z.string().min(1).max(200),
  phone: z.string().min(1).max(30),
  email: z.string().email().max(200),
  country: z.string().min(1).max(100),
  city: z.string().min(1).max(100),
  full_address: z.string().max(500).optional(),
  activity_type: z.enum(['Restaurant', 'Hotel', 'Commerce']),
  estimated_client_volume: z.number().int().optional(),
  available_space: z.string().max(500).optional(),
  opening_hours: z.string().max(500).optional(),
  justificatif_file: z.string().optional(),
  comment: z.string().max(1000).optional(),
  terms_accepted: z.boolean().refine(v => v === true, { message: 'Vous devez accepter les conditions agent' }),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = ApplySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const application = await agentService.applyForAgent(user.id, parsed.data as any);
    return new Response(JSON.stringify(application), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agent/apply]', error);
    const status = error.message === 'FORBIDDEN_MERCHANT' ? 403 : 500;
    return new Response(JSON.stringify({ error: error.message === 'FORBIDDEN_MERCHANT' ? 'FORBIDDEN' : 'SERVER_ERROR', message: error.message }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
