import type {RouteHandler} from '../../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {merchantReviewInbox,replyToReview} from '../../../../application/services/review-community-service.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(()=>merchantReviewInbox(visibilityActor(locals),visibilityId(url.searchParams.get('merchantProfileId'))));
export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{const b=await visibilityBody(request);return replyToReview(visibilityActor(locals),visibilityId(b.merchantProfileId),visibilityId(b.reviewId),b);});
