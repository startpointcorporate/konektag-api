import type {RouteHandler} from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import {visibilityHttp,visibilityActor,visibilityAdmin,visibilityBody,VisibilityError} from '../../../../application/services/visibility-shared.ts';
import {boostBillingProfiles,boostMerchantCurrency,resolveBoostCpm} from '../../../../application/services/merchant-social-boost-price-resolver.ts';
import {majorToMinor,minorDecimal} from '../../../../application/services/pay/money-unit.ts';

const required=(value:unknown,max:number,name:string)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new VisibilityError('INVALID_'+name,400);
  return value.trim();
};

/** Update one ERPNext Item Price, never the mapping. Explicit confirmation and expected-price check. */
export const POST:RouteHandler=({locals,request})=>visibilityHttp(async()=>{
  const actor=visibilityActor(locals);
  await visibilityAdmin(actor);
  const body=await visibilityBody(request);
  if(body.confirm!==true)throw new VisibilityError('CONFIRMATION_REQUIRED',400);
  const channel=required(body.channel,30,'CHANNEL').toLowerCase();
  const country=required(body.target_country,2,'TARGET_COUNTRY').toUpperCase();
  const company=required(body.billing_company,140,'BILLING_COMPANY');
  const expected=required(body.expected_cpm,40,'EXPECTED_CPM');
  const requested=required(body.new_cpm,40,'NEW_CPM');
  if(!['facebook','instagram','tiktok'].includes(channel)||!/^[A-Z]{2}$/.test(country))throw new VisibilityError('INVALID_CPM_SCOPE',400);
  const profiles=(await boostBillingProfiles()).filter((p:any)=>p.company===company);
  if(profiles.length!==1)throw new VisibilityError('BOOST_ERP_COMPANY_UNRESOLVED',422);
  const currency=boostMerchantCurrency(profiles[0].country_code);
  let expectedMinor:number,newMinor:number;
  try{expectedMinor=majorToMinor(expected,currency);newMinor=majorToMinor(requested,currency);}
  catch{throw new VisibilityError('INVALID_CPM_AMOUNT',422);}
  if(expectedMinor===newMinor)throw new VisibilityError('CPM_UNCHANGED',422);

  // Serializes updates through this backend. ERPNext external writers must still be coordinated.
  const db=await pool.connect();
  try{
    await db.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))',[company,channel+':'+country]);
    const {rows}=await db.query(`SELECT erpnext_item_code,price_list FROM konektag.merchant_social_boost_pricing
      WHERE channel=$1 AND target_country=$2 AND billing_company=$3 AND is_active=TRUE`,[channel,country,company]);
    if(rows.length!==1)throw new VisibilityError('BOOST_PRICE_NOT_CONFIGURED',409);
    const mapping=rows[0];
    const current=await resolveBoostCpm(channel,country,{company,currency},db);
    if(current.cpmMinor!==expectedMinor)throw new VisibilityError('CPM_PRICE_CHANGED',409);
    const {erpnext}=await import('../../../../infrastructure/adapters/erpnext-adapter.ts');
    const prices=await erpnext.listAdvanced('Item Price',{
      filters:{item_code:mapping.erpnext_item_code,price_list:mapping.price_list,currency},
      fields:['name','modified','price_list_rate'],limit:2
    });
    if(prices.length!==1)throw new VisibilityError('BOOST_PRICE_AMBIGUOUS_OR_MISSING',409);
    const record=prices[0];
    if(majorToMinor(String(record.price_list_rate),currency)!==expectedMinor)throw new VisibilityError('CPM_PRICE_CHANGED',409);
    // Re-read immediately before writing. ERPNext REST has no atomic compare-and-swap.
    const latest=await erpnext.get('Item Price',record.name);
    if(latest.modified!==record.modified||majorToMinor(String(latest.price_list_rate),currency)!==expectedMinor)
      throw new VisibilityError('CPM_PRICE_CHANGED',409);
    await erpnext.update('Item Price',record.name,{price_list_rate:Number(minorDecimal(newMinor,currency))});
    const verified=await resolveBoostCpm(channel,country,{company,currency},db);
    if(verified.cpmMinor!==newMinor)throw new VisibilityError('CPM_UPDATE_VERIFICATION_FAILED',503);
    console.info('[boost-pricing] CPM updated',{actor,channel,target_country:country,billing_company:company,item_price:record.name});
    return {updated:true,channel,target_country:country,billing_company:company,currency,
      previous_cpm:minorDecimal(expectedMinor,currency),cpm:minorDecimal(verified.cpmMinor,currency),
      item_price:record.name,verified:true};
  }finally{
    try{await db.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[company,channel+':'+country]);}
    finally{db.release();}
  }
});
