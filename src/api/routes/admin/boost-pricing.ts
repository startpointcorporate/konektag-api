import type {RouteHandler} from '../../http';
import {listBoostPricingMappings,saveBoostPricingMapping} from '../../../application/services/merchant-social-boost-pricing-service.ts';
import {visibilityHttp,visibilityActor,visibilityBody} from '../../../application/services/visibility-shared.ts';

export const GET:RouteHandler=({locals})=>visibilityHttp(async()=>listBoostPricingMappings(visibilityActor(locals)));

export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{
  const actor=visibilityActor(locals),body=await visibilityBody(request);
  return saveBoostPricingMapping(actor,body);
});
