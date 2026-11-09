import type {RouteHandler} from '../../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {moderationInbox,moderateReview} from '../../../../application/services/review-community-service.ts';
import {discoveryStatus,submitMerchantIndexNow,recordSearchObservation} from '../../../../application/services/merchant-discovery-service.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(async()=>{const actor=visibilityActor(locals),section=url.searchParams.get('section');if(section==='reports')return moderationInbox(actor,url.searchParams.get('includeResolved')==='true');if(section==='discovery')return discoveryStatus(actor,visibilityId(url.searchParams.get('merchantProfileId')),true);throw new VisibilityError('INVALID_SECTION',400);});
export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{const actor=visibilityActor(locals),b=await visibilityBody(request);switch(b.action){
 case 'moderate':return moderateReview(actor,visibilityId(b.reviewId),b);
 case 'indexnow':return submitMerchantIndexNow(actor,visibilityId(b.merchantProfileId));
 case 'observe':return recordSearchObservation(actor,visibilityId(b.merchantProfileId),b);
 default:throw new VisibilityError('INVALID_ACTION',400);}});
