import type { RouteHandler } from '../../../../../../http';
import { defaultDeps, hotelHandlers } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Records a Hospitality Hotel Reservation once per Idempotency-Key.
export const POST: RouteHandler = async context => hotelHandlers(await defaultDeps()).reserve(context);
