import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { transitionCoreTransaction } from '../../../../application/core-transaction-service.ts';

const bodySchema = z.object({
  merchantProfileId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  commandKey: z.string().min(1).max(200),
  command: z.enum(['CONFIRM','ALLOCATE','START','COMPLETE','CLOSE','CANCEL','EXPIRE','REJECT','DISPUTE']),
  allocations: z.array(z.object({ transactionLineId: z.string().uuid(), availabilityId: z.string().uuid(), units: z.number().int().positive() })).min(1).optional(),
});

export const POST: RouteHandler = async ({ request, locals, params }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success || !params.id) return new Response(JSON.stringify({ error: 'INVALID_COMMAND' }), { status: 422 });
  try {
    const result = await transitionCoreTransaction({ ...body.data, transactionId: params.id, actorUserId: locals.user.id });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SERVER_ERROR';
    const status = code === 'MERCHANT_ACCESS_DENIED' ? 403 : code === 'TRANSACTION_NOT_FOUND' ? 404
      : ['VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','CAPACITY_EXCEEDED','LINE_CAPACITY_EXCEEDED'].includes(code) ? 409
      : ['INVALID_TRANSITION','INVALID_COMMAND','ALLOCATION_REQUIRED','ALLOCATION_INCOMPLETE','AVAILABILITY_NOT_FOUND','LINE_NOT_FOUND'].includes(code) ? 422 : 500;
    return new Response(JSON.stringify({ error: code }), { status });
  }
};
