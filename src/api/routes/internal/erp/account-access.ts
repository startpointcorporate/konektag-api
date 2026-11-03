import type { RouteHandler } from '../../../http';
import crypto from 'node:crypto';
import { changeAccountAccess } from '../../../../application/services/account-access-service.ts';

export const POST: RouteHandler = async ({ request }) => {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const expected = process.env.ERP_ACCESS_SYNC_TOKEN;
  if (!token || !expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.userId !== 'string' || typeof body.actorId !== 'string' || typeof body.blocked !== 'boolean' || typeof body.reason !== 'string' || typeof body.reference !== 'string') return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  const result = await changeAccountAccess({ userId: body.userId, actorId: body.actorId, blocked: body.blocked, reason: body.reason, idempotencyKey: `erp-access:${body.reference}`, sourceSystem: 'ERP', externalReference: body.reference });
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
