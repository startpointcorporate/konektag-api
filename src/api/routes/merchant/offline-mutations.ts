import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { applyMerchantOfflineMutation } from '../../../application/merchant-offline-mutation-service.ts';
import { operationsJson, operationsError } from '../../../application/merchant-operations-http.ts';

const schema = z.object({
  commandId: z.string().uuid(), merchantProfileId: z.string().uuid(),
  objectType: z.enum(['account', 'profile', 'commerce', 'product', 'tax']), objectId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(), patch: z.record(z.string(), z.unknown()),
}).strict();
export const POST: RouteHandler = async ({ locals, request }) => {
  if (!locals.user) return operationsJson({ error: 'UNAUTHORIZED' }, 401);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return operationsJson({ error: 'INVALID_OFFLINE_MUTATION' }, 422);
  try { return operationsJson(await applyMerchantOfflineMutation(locals.user.id, parsed.data)); }
  catch (error) { return operationsError(error); }
};
