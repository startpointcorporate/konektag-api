import type { RouteHandler } from '../../../http';
import { agentInquiryService } from '../../../../application/agent-inquiry-service.ts';
import { z } from 'zod';
import { forbiddenResponse, requireBackofficePermission } from '../../../../application/services/backoffice-permission-service.ts';

const UpdateSchema = z.object({
  status: z.enum(['pending', 'contacted', 'approved', 'rejected']).optional(),
  action: z.enum(['activate_agent']).optional(),
});

export const PUT: RouteHandler = async ({ request, locals, params }) => {
  const auth = await requireBackofficePermission('merchants:write')(locals);
  if (!auth.authorized || !auth.user) return forbiddenResponse(auth.reason);
  const user = auth.user;
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    if (parsed.data.action === 'activate_agent') {
      const result = await agentInquiryService.activateAgentFromInquiry(params.id!, user.id);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400 });
    }
    if (parsed.data.status) {
      await agentInquiryService.updateStatus(params.id!, parsed.data.status, user.id);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  } catch (error: any) {
    console.error('[agent/inquiries PUT]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
