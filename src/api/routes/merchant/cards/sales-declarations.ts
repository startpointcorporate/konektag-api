import type { RouteHandler } from '../../../http';
import { cardBatchService } from '../../../../application/services/card-batch-service.ts';
import { cardLifecycleService } from '../../../../application/services/card-lifecycle-service.ts';

export const POST: RouteHandler = async ({ locals, request }) => {
  const user = (locals as any).user;
  if (!user || !await cardBatchService.isAgent(user.id)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.cardNumbers) || typeof body.declarationRef !== 'string' || typeof body.countryCode !== 'string') return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  const result = await cardLifecycleService.declareSale({ merchantUserId: user.id, cardNumbers: body.cardNumbers, declarationRef: body.declarationRef, countryCode: body.countryCode.toUpperCase(), evidenceUrl: body.evidenceUrl });
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
