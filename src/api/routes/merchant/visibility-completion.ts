import type {RouteHandler} from '../../http';
import {merchantService} from '../../../application/merchant-service.ts';
import {assessMerchantVisibility} from '../../../application/shared/merchant-visibility.ts';

export const GET:RouteHandler=async ({locals,url})=>{
  if(!locals.user)return new Response(JSON.stringify({error:'UNAUTHORIZED'}),{status:401});
  const profileId=url.searchParams.get('merchantProfileId');
  if(!profileId)return new Response(JSON.stringify({error:'PROFILE_ID_REQUIRED'}),{status:400});
  try{
    const profile=await merchantService.getManagedProfile(locals.user.id,profileId);
    const {score,level,remaining,items}=assessMerchantVisibility(profile,undefined,url.searchParams.get('locale')||locals.user.locale||'fr');
    return new Response(JSON.stringify({score,level,remaining,items}),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }catch{
    return new Response(JSON.stringify({error:'PROFILE_UNAVAILABLE'}),{status:404,headers:{'Cache-Control':'no-store'}});
  }
};
