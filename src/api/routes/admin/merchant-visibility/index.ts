import {listConnections,createConnection,setConnectionActive,listConnectionAccounts,adminMerchantSettings,saveMerchantSettings} from '../../../../application/services/postiz-connections.ts';
import type {RouteHandler} from '../../../http';
import {visibilityHttp,visibilityActor,visibilityBody,visibilityId,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {campaignList,setCampaignFinalMedia,claimFreePublication,attachManualPost,approveCampaign,scheduleCampaign,syncCampaign,resetFailedCampaign,cancelCampaign} from '../../../../application/services/merchant-social-service.ts';
import {listSocialBoosts,administerSocialBoost} from '../../../../application/services/merchant-social-boost-service.ts';
import {moderationInbox,moderateReview} from '../../../../application/services/review-community-service.ts';
import {discoveryStatus,submitMerchantIndexNow,recordSearchObservation} from '../../../../application/services/merchant-discovery-service.ts';
export const GET:RouteHandler=({locals,url})=>visibilityHttp(async()=>{const actor=visibilityActor(locals),section=url.searchParams.get('section');if(section==='boosts')return listSocialBoosts(actor);if(section==='connections')return listConnections(actor);if(section==='accounts')return listConnectionAccounts(actor,visibilityId(url.searchParams.get('connectionId')));if(section==='postiz-settings')return adminMerchantSettings(actor,visibilityId(url.searchParams.get('merchantProfileId')));if(section==='reports')return moderationInbox(actor,url.searchParams.get('includeResolved')==='true');if(section==='discovery')return discoveryStatus(actor,visibilityId(url.searchParams.get('merchantProfileId')),true);return {...await campaignList(actor),...await listSocialBoosts(actor)};});
export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{const actor=visibilityActor(locals),b=await visibilityBody(request);switch(b.action){
 case 'payment-link':case 'configure':case 'target-published':case 'boosted':case 'complete':case 'erp-sync':return administerSocialBoost(actor,visibilityId(b.id),b);
 case 'create-connection':return createConnection(actor,b);
 case 'connection-active':return setConnectionActive(actor,visibilityId(b.connectionId),b.active);
 case 'postiz-settings':return saveMerchantSettings(actor,visibilityId(b.merchantProfileId),b);
 case 'cancel':return cancelCampaign(actor,visibilityId(b.id),b.expectedVersion);
 case 'set-final-media':return setCampaignFinalMedia(actor,visibilityId(b.id),b);
 case 'claim-free':return claimFreePublication(actor,visibilityId(b.id),b.expectedVersion);
 case 'attach-postiz':return attachManualPost(actor,visibilityId(b.id),b);
 case 'approve':return approveCampaign(actor,visibilityId(b.id),b.expectedVersion);
 case 'schedule':return scheduleCampaign(actor,visibilityId(b.id),b);
 case 'sync':return syncCampaign(actor,visibilityId(b.id));
 case 'reset':return resetFailedCampaign(actor,visibilityId(b.id),b.expectedVersion);
 case 'moderate':return moderateReview(actor,visibilityId(b.reviewId),b);
 case 'indexnow':return submitMerchantIndexNow(actor,visibilityId(b.merchantProfileId));
 case 'observe':return recordSearchObservation(actor,visibilityId(b.merchantProfileId),b);
 default:throw new VisibilityError('INVALID_ACTION',400);}});

