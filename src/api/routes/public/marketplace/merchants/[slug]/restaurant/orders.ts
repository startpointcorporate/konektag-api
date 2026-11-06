import type { RouteHandler } from '../../../../../../http';
import { defaultDeps, restaurantHandlers } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Records a Lumen POS Restaurant Order once per Idempotency-Key.
export const POST: RouteHandler = async context => restaurantHandlers(await defaultDeps()).order(context);
