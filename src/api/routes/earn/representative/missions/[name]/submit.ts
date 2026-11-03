import type { RouteHandler } from '../../../../../http';
import { ambassadorService } from '../../../../../../application/services/ambassador-service.ts';
import { z } from 'zod';

const SubmitSchema = z.object({
  evidence: z.array(z.object({
    evidence_type: z.enum(['Photo', 'Video', 'Document', 'CustomerReview', 'Comment']),
    file_url: z.string().max(500).optional(),
    comment: z.string().max(5000).optional(),
  }).refine(e => !!e.file_url?.trim() || !!e.comment?.trim(), {
    message: 'Une preuve doit contenir un fichier ou un commentaire',
  })).min(1),
});

export const POST: RouteHandler = async ({ params, request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const parsed = SubmitSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const mission = await ambassadorService.submitMission(params.name!, user.id, parsed.data);
    return new Response(JSON.stringify(mission), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[earn/rep/submit]', error);
    const status = error.message === 'FORBIDDEN_MISSION' ? 403 : error.message === 'INVALID_EVIDENCE' ? 422 : 500;
    const code = status === 403 ? 'FORBIDDEN' : status === 422 ? 'INVALID_EVIDENCE' : 'SERVER_ERROR';
    return new Response(JSON.stringify({ error: code, message: error.message }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
