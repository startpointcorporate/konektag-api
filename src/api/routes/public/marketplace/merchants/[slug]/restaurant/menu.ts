import type { RouteHandler } from '../../../../../../http';
import { catalogueHandlers, defaultDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';

// Orderable Lumen dishes and today's prices, behind a published restaurant capability. Read only.
export const GET: RouteHandler = async context => catalogueHandlers(await defaultDeps()).menu(context);
