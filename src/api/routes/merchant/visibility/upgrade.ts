import type {RouteHandler} from '../../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {merchantUpgradeAdvice} from '../../../../application/services/merchant-upgrade-advice.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(()=>merchantUpgradeAdvice(visibilityActor(locals),visibilityId(url.searchParams.get('merchantProfileId')),url.searchParams.get('context')||'analytics'));
