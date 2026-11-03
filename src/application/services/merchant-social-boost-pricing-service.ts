import countries from 'i18n-iso-countries';
import {boostMerchantCurrency,boostBillingProfiles} from './merchant-social-boost-price-resolver.ts';
import pool from '../../infrastructure/database/pool.ts';
import {visibilityAdmin,VisibilityError} from './visibility-shared.ts';
import {isPostizPlatform} from './postiz-connections.ts';

const text=(value:unknown,max:number,field:string)=>{
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new VisibilityError('INVALID_'+field.toUpperCase(),422);
  return value.trim();
};

export async function listBoostPricingMappings(actor:string){
  await visibilityAdmin(actor);
  const {rows}=await pool.query(`SELECT id,channel,target_country,target_country_name,erpnext_item_code,price_list,billing_company,is_active,created_at,updated_at
    FROM konektag.merchant_social_boost_pricing ORDER BY target_country_name,channel,billing_company`);
  const entities=await boostBillingProfiles();
  return {mappings:rows,billingCompanies:entities.map((entity:any)=>({...entity,currency:boostMerchantCurrency(entity.country_code)}))};
}

export async function saveBoostPricingMapping(actor:string,input:Record<string,unknown>){
  await visibilityAdmin(actor);
  const channel=text(input.channel,80,'channel');
  if(!isPostizPlatform(channel))throw new VisibilityError('INVALID_CHANNEL',422);
  const targetCountry=text(input.targetCountry,2,'target_country').toUpperCase();
  if(!/^[A-Z]{2}$/.test(targetCountry)||!countries.isValid(targetCountry))throw new VisibilityError('INVALID_TARGET_COUNTRY',422);
  const targetCountryName=text(input.targetCountryName,120,'target_country_name');
  const erpnextItemCode=text(input.erpnextItemCode,140,'erpnext_item_code');
  const priceList=text(input.priceList||'Standard Selling',140,'price_list');
  const billingCompany=text(input.billingCompany,140,'billing_company');
  const entities=(await boostBillingProfiles()).filter((row:any)=>row.company===billingCompany);
  if(entities.length!==1)throw new VisibilityError('BOOST_ERP_COMPANY_UNRESOLVED',422);
  const currency=boostMerchantCurrency(entities[0].country_code);
  const {erpnext}=await import('../../infrastructure/adapters/erpnext-adapter.ts');
  const [item,list]=await Promise.all([erpnext.get('Item',erpnextItemCode),erpnext.get('Price List',priceList)]);
  if(item.disabled||Number(item.is_stock_item)!==0||!item.item_defaults?.some((row:any)=>row.company===billingCompany))
    throw new VisibilityError('BOOST_ITEM_COMPANY_MISMATCH',422);
  if(!list.enabled||!list.selling||list.currency!==currency)throw new VisibilityError('BOOST_PRICE_CURRENCY_MISMATCH',422);
  if(typeof input.isActive!=='boolean')throw new VisibilityError('INVALID_IS_ACTIVE',422);
  const {rows:[mapping]}=await pool.query(`INSERT INTO konektag.merchant_social_boost_pricing
    (channel,target_country,target_country_name,erpnext_item_code,price_list,is_active,created_by,updated_by,billing_company)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)
    ON CONFLICT(channel,target_country,billing_company) DO UPDATE SET
      target_country_name=EXCLUDED.target_country_name,
      erpnext_item_code=EXCLUDED.erpnext_item_code,
      price_list=EXCLUDED.price_list,
      is_active=EXCLUDED.is_active,
      updated_by=EXCLUDED.updated_by,
      updated_at=now()
    RETURNING id,channel,target_country,target_country_name,erpnext_item_code,price_list,billing_company,is_active,created_at,updated_at`,
    [channel,targetCountry,targetCountryName,erpnextItemCode,priceList,input.isActive,actor,billingCompany]);
  return {mapping};
}
