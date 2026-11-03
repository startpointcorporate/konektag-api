import pool from '../../infrastructure/database/pool.ts';
import {countryCode,currencyForMerchantCountry} from './country-currency-service.ts';
import {exchangeRateService} from './exchange-rate-service.ts';
import {majorToMinor,convertMinor} from './pay/money-unit.ts';
import {VisibilityError} from './visibility-shared.ts';

// Lebanon's approved USD configuration applies only to boosts, not to other products.
export function boostMerchantCountry(value:unknown){
  const normalized=typeof value==='string'?value.trim().toLowerCase():'';
  return ['lb','liban','lebanon'].includes(normalized)?'LB':countryCode(value);
}
export function boostMerchantCurrency(value:unknown){
  return boostMerchantCountry(value)==='LB'?'USD':currencyForMerchantCountry(value);
}
// Pricing profiles come from the explicit CPM configuration, not legal/compliance approval.
// Invoice creation still performs its independent approved-legal-entity check.
export async function boostBillingProfiles(db:any=pool){
  const {rows}=await db.query(`SELECT DISTINCT billing_company AS company, RIGHT(erpnext_item_code,2) AS country_code
    FROM konektag.merchant_social_boost_pricing
    WHERE billing_company IS NOT NULL AND erpnext_item_code ~ '^KTG-BOOST-(FACEBOOK|INSTAGRAM|TIKTOK)-(FR|CG|LB)$'
    ORDER BY company,country_code`);
  return rows;
}
export async function boostBillingContext(country:unknown,db:any=pool){
  const code=boostMerchantCountry(country),currency=boostMerchantCurrency(country);
  const rows=(await boostBillingProfiles(db)).filter((row:any)=>row.country_code===code);
  if(rows.length!==1)throw new VisibilityError('BOOST_ERP_COMPANY_UNRESOLVED',503);
  return {country:code,currency,company:String(rows[0].company)};
}
export async function resolveBoostCpm(channel:string,targetCountry:string,context:{company:string;currency:string},db:any=pool){
  const {rows}=await db.query(`SELECT channel,target_country,target_country_name,erpnext_item_code,price_list,billing_company
    FROM konektag.merchant_social_boost_pricing
    WHERE channel=$1 AND target_country=$2 AND billing_company=$3 AND is_active=TRUE`,[channel,targetCountry,context.company]);
  if(rows.length!==1)throw new VisibilityError('BOOST_PRICE_NOT_CONFIGURED',503);
  const mapping=rows[0];
  const {erpnext}=await import('../../infrastructure/adapters/erpnext-adapter.ts');
  const [item,list,prices]=await Promise.all([
    erpnext.get('Item',mapping.erpnext_item_code),erpnext.get('Price List',mapping.price_list),
    erpnext.listAdvanced('Item Price',{filters:{item_code:mapping.erpnext_item_code,currency:context.currency,price_list:mapping.price_list},
      fields:['name','price_list_rate','currency','uom','customer','supplier','batch_no','packing_unit','valid_from','valid_upto','selling'],limit:2}),
  ]);
  if(item.disabled||Number(item.is_stock_item)!==0||!item.item_defaults?.some((row:any)=>row.company===context.company))
    throw new VisibilityError('BOOST_ITEM_COMPANY_MISMATCH',503);
  if(!list.enabled||!list.selling||list.currency!==context.currency)throw new VisibilityError('BOOST_PRICE_CURRENCY_MISMATCH',503);
  if(prices?.length!==1)throw new VisibilityError('BOOST_PRICE_AMBIGUOUS_OR_MISSING',503);
  const price=prices[0];
  // A CPM is a generic service price. Reject conditional prices rather than choose one arbitrarily.
  if(price.currency!==context.currency||!price.selling||price.customer||price.supplier||price.batch_no||
    Number(price.packing_unit||0)>1||price.valid_from&&price.valid_from>new Date().toISOString().slice(0,10)||
    price.valid_upto&&price.valid_upto<new Date().toISOString().slice(0,10)||price.uom&&price.uom!==item.stock_uom)
    throw new VisibilityError('BOOST_PRICE_CONDITIONAL',503);
  let cpmMinor:number;
  try{cpmMinor=majorToMinor(String(price.price_list_rate),context.currency);}catch{throw new VisibilityError('BOOST_PRICE_NOT_CONFIGURED',503);}
  return {mapping,cpmMinor};
}

/** Target-country CPM resolution is independent from the merchant's billing country.
 * All consumers (public estimates and merchant quotes) must use this same resolver.
 */
export async function resolveTargetBoostCpm(channel:string,targetCountry:string,db:any=pool){
 const target=targetCountry.trim().toUpperCase();
 const region=target==='LB'?'LB':['CG','CM','GA','TD','CF','GQ'].includes(target)?'CG':'FR';
 const profiles=(await boostBillingProfiles(db)).filter((p:any)=>p.country_code===region);
 if(profiles.length!==1)throw new VisibilityError('BOOST_TARGET_BILLING_PROFILE_UNRESOLVED',503);
 const profile=profiles[0],currency=boostMerchantCurrency(region);
 const result=await resolveBoostCpm(channel,target,{company:profile.company,currency},db);
 return {...result,currency,company:String(profile.company)};
}

/** Convert an approved CPM to the merchant's invoice currency using a live, evidenced rate. */
export async function convertBoostCpm(cpmMinor:number,from:string,to:string){
 if(from===to)return cpmMinor;
 const evidence=await exchangeRateService.getRateEvidence(from,to);
 if(!evidence)throw new VisibilityError('BOOST_FX_RATE_MISSING',503);
 const converted=convertMinor(cpmMinor,from,to,evidence.rate,evidence.inverse);
 if(!Number.isSafeInteger(converted)||converted<=0)throw new VisibilityError('BOOST_CONVERTED_CPM_INVALID',503);
 return converted;
}
