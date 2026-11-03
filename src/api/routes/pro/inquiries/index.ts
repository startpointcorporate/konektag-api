import type { RouteHandler } from '../../../http';
import { proInquiryService } from '../../../../application/pro-inquiry-service.ts';
import { z } from 'zod';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';
import { entitlementDecisionService, entitlementResponse } from '../../../../application/services/entitlement-decision-service.ts';

const CreateSchema = z.object({
  businessName: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(30).optional(),
  country: z.string().max(100).optional(),
  offerName: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
  merchantProfileId: z.string().uuid().optional(),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    if (parsed.data.merchantProfileId) {
      if (!locals.user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
      const access = await entitlementDecisionService.decide({ actorId: locals.user.id,
        merchantId: parsed.data.merchantProfileId, capability: 'marketplace.profile' });
      if (!access.allowed) return entitlementResponse(access);
    }
    const result = await proInquiryService.create(parsed.data);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[pro/inquiries POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const GET: RouteHandler = async ({ url, locals }) => {
  const access = await requireBackofficePermission('merchants:write')(locals);
  if (!access.authorized || access.user?.role !== 'admin') return forbiddenResponse(access.reason);
  try {
    const status = url.searchParams.get('status') || undefined;
    const inquiries = await proInquiryService.list(status);
    return new Response(JSON.stringify(inquiries), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[pro/inquiries GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
