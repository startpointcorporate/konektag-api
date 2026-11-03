import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { merchantOperations, operationEstablishments } from '../../../../application/merchant-operations-service.ts';
import { operationsJson, operationsError } from '../../../../application/merchant-operations-http.ts';
const querySchema = z.object({ merchantProfileId: z.string().uuid(), search: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict();
export const GET: RouteHandler = async ({ locals, url }) => {
  if (!locals.user) return operationsJson({ error: 'UNAUTHORIZED' },401);
  try {
    if (!url.search) return operationsJson({ establishments: await operationEstablishments(locals.user.id) });
    const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return operationsJson({ error: 'INVALID_QUERY' },422);
    const { merchantProfileId, search, page } = query.data;
    return operationsJson(await merchantOperations(locals.user.id,merchantProfileId,search,page));
  } catch(error) { return operationsError(error); }
};
