import type {RouteHandler} from '../../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {discoveryStatus} from '../../../../application/services/merchant-discovery-service.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(()=>discoveryStatus(visibilityActor(locals),visibilityId(url.searchParams.get('merchantProfileId'))));
