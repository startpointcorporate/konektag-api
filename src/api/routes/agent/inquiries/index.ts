import type { RouteHandler } from '../../../http';
import { agentInquiryService } from '../../../../application/agent-inquiry-service.ts';
import { z } from 'zod';
import pool from '../../../../infrastructure/database/pool.ts';
import { forbiddenResponse, requireBackofficePermission } from '../../../../application/services/backoffice-permission-service.ts';

const CreateSchema = z.object({
  businessName: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(30).optional(),
  country: z.string().max(100).optional(),
  message: z.string().max(5000).optional(),
  motivation: z.string().max(5000).optional(),
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
    const user = (locals as any).user;
    let merchantProfileId: string | null = null;

    if (user) {
      const { rows: [mp] } = await pool.query(
        `SELECT mp.id FROM konektag.merchant_profiles mp
         JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
           AND mm.user_id = $1 AND mm.status = 'active'
         WHERE mp.deleted_at IS NULL AND mp.status = 'Published'
         ORDER BY mm.is_primary DESC, mp.created_at DESC LIMIT 1`,
        [user.id],
      );
      merchantProfileId = mp?.id ?? null;
    }

    const result = await agentInquiryService.create({
      ...parsed.data,
      merchantProfileId: merchantProfileId ?? undefined,
    });
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agent/inquiries POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const GET: RouteHandler = async ({ url, locals }) => {
  const auth = await requireBackofficePermission('merchants:read')(locals);
  if (!auth.authorized) return forbiddenResponse(auth.reason);
  try {
    const status = url.searchParams.get('status') || undefined;
    const inquiries = await agentInquiryService.list(status);
    return new Response(JSON.stringify(inquiries), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agent/inquiries GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
