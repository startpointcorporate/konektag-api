import type {RouteHandler} from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import {visibilityHttp,visibilityActor,visibilityAdmin,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {boostBillingProfiles,boostMerchantCurrency,resolveBoostCpm} from '../../../../application/services/merchant-social-boost-price-resolver.ts';
import {minorDecimal} from '../../../../application/services/pay/money-unit.ts';

/** Admin-only resolved CPMs. Reuses the exact resolver used by customer quotes. */
export const GET:RouteHandler=({locals,url})=>visibilityHttp(async()=>{
  const actor=visibilityActor(locals);
  await visibilityAdmin(actor);
  const channel=url.searchParams.get('channel')?.toLowerCase();
  const country=url.searchParams.get('target_country')?.toUpperCase();
  const company=url.searchParams.get('billing_company');
  if(!channel||!['facebook','instagram','tiktok'].includes(channel))throw new VisibilityError('INVALID_CHANNEL',400);
  if(!country||!/^[A-Z]{2}$/.test(country))throw new VisibilityError('INVALID_TARGET_COUNTRY',400);
  const {rows}=await pool.query(`SELECT channel,target_country,target_country_name,billing_company,erpnext_item_code,price_list,is_active
    FROM konektag.merchant_social_boost_pricing
    WHERE channel=$1 AND target_country=$2 AND ($3::text IS NULL OR billing_company=$3)
    ORDER BY billing_company`,[channel,country,company||null]);
  const profiles=await boostBillingProfiles();
  const prices=[];
  for(const mapping of rows){
    const profile=profiles.find((p:any)=>p.company===mapping.billing_company);
    if(!profile){prices.push({...mapping,price_status:'BILLING_PROFILE_MISSING'});continue;}
    const currency=boostMerchantCurrency(profile.country_code);
    if(!mapping.is_active){prices.push({...mapping,currency,price_status:'INACTIVE'});continue;}
    try{
      const resolved=await resolveBoostCpm(channel,country,{company:mapping.billing_company,currency});
      prices.push({...mapping,currency,cpm_minor:resolved.cpmMinor,
        cpm:minorDecimal(resolved.cpmMinor,currency),price_status:'VERIFIED'});
    }catch(e){
      if(e instanceof VisibilityError){prices.push({...mapping,currency,price_status:e.code});continue;}
      throw e;
    }
  }
  return {channel,target_country:country,prices,complete:true};
});
