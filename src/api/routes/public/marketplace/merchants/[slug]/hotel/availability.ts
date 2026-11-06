import type { RouteHandler } from '../../../../../../http';
import { defaultDeps, hotelHandlers } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Live Hospitality availability by dates and travellers. Read only.
export const GET: RouteHandler = async context => hotelHandlers(await defaultDeps()).availability(context);
