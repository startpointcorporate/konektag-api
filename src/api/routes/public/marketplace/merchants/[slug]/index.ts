import type { RouteHandler } from '../../../../../http';
import { defaultDeps, profileHandler } from '../../../../../../application/marketplace-transactions/http-handlers.ts';

// Published Marketplace profile by slug (API #24). Read only; absent or unpublished → 404.
export const GET: RouteHandler = async context => profileHandler(await defaultDeps())(context);
