import type { RouteHandler } from '../../../../../../http';
import { catalogueHandlers, defaultDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Bookable Hospitality room types, behind a published hotel capability. Read only.
export const GET: RouteHandler = async context => catalogueHandlers(await defaultDeps()).rooms(context);
