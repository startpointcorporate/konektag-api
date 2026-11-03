import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { recordEvent } from '../../../application/growth-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

const Schema = z.object({ destinationId: z.string().uuid(), attributionId: z.string().uuid(), eventType: z.enum(['smart_qr_scan', 'destination_opened', 'offer_clicked', 'promotion_clicked', 'content_shared', 'conversion']), eventKey: z.string().min(1).max(200).optional(), conversionReference: z.string().max(200).nullable().optional(), metadata: z.record(z.unknown()).optional() });

export const POST: RouteHandler = async ({ request, locals }) => {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 422 });
  try {
    let userId: string | null = null;
    if (locals.user) {
      const { rows: [user] } = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [locals.user.keycloak_id]);
      userId = user?.id ?? null;
    }
    const result = await recordEvent({ ...parsed.data, userId });
    return new Response(JSON.stringify(result), { status: 202, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    const status = error.message === 'CONVERSION_NOT_CONFIRMED' ? 409 : error.message?.includes('NOT_FOUND') || error.message === 'TARGET_NOT_ACTIVE' ? 404 : 422;
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
