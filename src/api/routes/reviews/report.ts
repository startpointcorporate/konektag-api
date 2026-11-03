import type {RouteHandler} from '../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId} from '../../../application/services/visibility-shared.ts';
import {reportReview} from '../../../application/services/review-community-service.ts';
export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{const b=await visibilityBody(request);return reportReview(visibilityActor(locals),visibilityId(b.reviewId),b);});
