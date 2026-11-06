import type { RouteHandler } from '../../../../../../http';
import { defaultDeps, restaurantHandlers } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Re-prices a cart against the outlet's live Lumen price list. Read only.
export const POST: RouteHandler = async context => restaurantHandlers(await defaultDeps()).quote(context);
