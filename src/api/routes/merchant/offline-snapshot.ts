import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { merchantOfflineSnapshot } from '../../../application/merchant-offline-service.ts';
import { operationsJson, operationsError } from '../../../application/merchant-operations-http.ts';

const query = z.object({ merchantProfileId: z.string().uuid() }).strict();
export const GET: RouteHandler = async ({ locals, url }) => {
  if (!locals.user) return operationsJson({ error: 'UNAUTHORIZED' }, 401);
  const parsed = query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return operationsJson({ error: 'INVALID_QUERY' }, 422);
  try { return operationsJson(await merchantOfflineSnapshot(locals.user.id, parsed.data.merchantProfileId)); }
  catch (error) { return operationsError(error); }
};
