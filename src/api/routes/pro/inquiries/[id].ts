import type { RouteHandler } from '../../../http';
import { proInquiryService } from '../../../../application/pro-inquiry-service.ts';
import { z } from 'zod';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

const UpdateSchema = z.object({
  status: z.enum(['pending', 'contacted', 'approved', 'rejected']),
});

export const PUT: RouteHandler = async ({ request, locals, params }) => {
  const access = await requireBackofficePermission('merchants:write')(locals);
  if (!access.authorized || access.user?.role !== 'admin') return forbiddenResponse(access.reason);
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
    await proInquiryService.updateStatus(params.id!, parsed.data.status);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error: any) {
    console.error('[pro/inquiries PUT]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
