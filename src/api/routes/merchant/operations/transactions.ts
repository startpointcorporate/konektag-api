import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { createCoreTransaction } from '../../../../application/core-transaction-service.ts';
import { operationsJson, operationsError } from '../../../../application/merchant-operations-http.ts';
const schema = z.object({
  merchantProfileId: z.string().uuid(), requestKey: z.string().min(1).max(200),
  kind: z.enum(['ORDER','RESERVATION','REQUEST']), note: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
  promotionId: z.string().uuid().optional(), promotionFingerprint: z.string().length(64).optional(),
  lines: z.array(z.object({ offerId: z.string().uuid(), pricingRuleId: z.string().uuid(), quantity: z.number().int().positive().max(2147483647) }).strict()).min(1).max(100),
}).passthrough();
export const POST: RouteHandler = async ({ locals, request }) => {
  if (!locals.user) return operationsJson({ error: 'UNAUTHORIZED' },401);
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return operationsJson({ error: 'INVALID_MERCHANT_TRANSACTION' },422);
  try {
    const { merchantProfileId, requestKey, kind, note, scheduledAt, promotionId, promotionFingerprint, lines } = body.data;
    const id = await createCoreTransaction({ merchantProfileId, requestKey, kind, note, scheduledAt,
      customerUserId: null, merchantActorUserId: locals.user.id, promotionId, promotionFingerprint,
      lines: lines.map(line => ({ offerId: line.offerId, pricingRuleId: line.pricingRuleId, quantity: line.quantity, label: 'Catalogue' })) });
    return operationsJson({ id });
  } catch(error) { return operationsError(error); }
};
