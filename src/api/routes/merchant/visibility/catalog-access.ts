import type {RouteHandler} from '../../../http';
import {merchantCatalogAccess} from '../../../../application/services/merchant-catalog-access.ts';
import {visibilityActor,visibilityId,visibilityHttp} from '../../../../application/services/visibility-shared.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(()=>merchantCatalogAccess(visibilityActor(locals),visibilityId(url.searchParams.get('merchantProfileId'))));
