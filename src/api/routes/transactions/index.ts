import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { createCoreTransaction } from '../../../application/core-transaction-service.ts';

const bodySchema = z.object({
  merchantProfileId: z.string().uuid(), kind: z.enum(['ORDER', 'RESERVATION', 'REQUEST']),
  requestKey: z.string().min(1).max(200), scheduledAt: z.string().datetime().optional(), note: z.string().max(2000).optional(),
  promotionId: z.string().uuid().optional(), promotionFingerprint: z.string().length(64).optional(),
  lines: z.array(z.object({ offerId: z.string().uuid().optional(), pricingRuleId: z.string().uuid().optional(),
    label: z.string().min(1), quantity: z.number().int().positive(), unitPrice: z.object({
      amountMinor: z.number().int().nonnegative(), currency: z.string().length(3),
    }).optional() })).min(1),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return new Response(JSON.stringify({ error: 'INVALID_TRANSACTION' }), { status: 422 });
  try {
    const id = await createCoreTransaction({ ...body.data, customerUserId: locals.user.id });
    return new Response(JSON.stringify({ id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SERVER_ERROR';
    const status = code === 'IDEMPOTENCY_CONFLICT' || code === 'PROMOTION_VERSION_CONFLICT' ? 409 :
      (code.startsWith('INVALID') || code === 'PRICE_MISMATCH' || code === 'PROMOTION_CONFLICT' || code === 'PROMOTION_NOT_APPLICABLE') ? 422 : 500;
    return new Response(JSON.stringify({ error: code }), { status });
  }
};
