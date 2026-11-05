import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),get:vi.fn(),list:vi.fn(),admin:vi.fn(),manager:vi.fn()}));
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:mocks.query}}));
vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts',()=>({erpnext:{get:mocks.get,listAdvanced:mocks.list}}));
vi.mock('../../src/application/services/visibility-shared.ts',()=>({visibilityAdmin:mocks.admin,visibilityManager:mocks.manager,VisibilityError:class extends Error{constructor(code:string){super(code);}}}));
vi.mock('../../src/application/services/postiz-connections.ts',()=>({isPostizPlatform:(v:string)=>/^[a-z][a-z0-9_-]*$/.test(v)}));
import {boostBillingContext,boostMerchantCurrency,resolveBoostCpm} from '../../src/application/services/merchant-social-boost-price-resolver.ts';
import {saveBoostPricingMapping} from '../../src/application/services/merchant-social-boost-pricing-service.ts';
import {listSocialBoostTargetCountries} from '../../src/application/services/merchant-social-boost-service.ts';
import {currencyForMerchantCountry} from '../../src/application/services/country-currency-service.ts';
const billings=[['FR','Konektag France','EUR'],['CG','Konektag Congo','XAF'],['LB','Konektag Liban','USD']];
const targets=['FR','BE','DE','ES','IT','CG','CM','GA','TD','CF','GQ','LB'];
let mapping:any,item:any,list:any,prices:any[];
beforeEach(()=>{
 vi.clearAllMocks();
 mapping={erpnext_item_code:'KTG-BOOST-FACEBOOK-FR',price_list:'KTG-CPM-CG-EUR',target_country_name:'Congo'};
 item={disabled:0,is_stock_item:0,stock_uom:'Nos',item_defaults:[{company:'Konektag France'}]};
 list={enabled:1,selling:1,currency:'EUR'};
 prices=[{name:'IP',price_list_rate:3.12,currency:'EUR',selling:1,uom:'Nos'}];
 mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT DISTINCT billing_company')?[{company:'Konektag France',country_code:'FR'}]:sql.includes('INSERT INTO')?[mapping]:[mapping]}));
 mocks.get.mockImplementation(async(dt:string)=>dt==='Item'?item:list);mocks.list.mockImplementation(async()=>prices);
});
describe('CPM selection across billing companies and target countries',()=>{
 for(const [merchant,company,currency] of billings)for(const target of targets)for(const channel of ['facebook','instagram','tiktok']){
  it(`${merchant} bills ${channel} targeting ${target} with its own item and currency`,async()=>{
   mocks.query.mockResolvedValueOnce({rows:[{company,country_code:merchant}]}).mockResolvedValueOnce({rows:[{...mapping,erpnext_item_code:`KTG-BOOST-${channel.toUpperCase()}-${merchant}`,price_list:`KTG-CPM-${target}-${currency}`} ]});
   item.item_defaults=[{company}];list.currency=currency;prices[0].currency=currency;prices[0].price_list_rate=currency==='XAF'?1800:3.12;
   const context=await boostBillingContext(merchant);
   const result=await resolveBoostCpm(channel,target,context);
   expect(context).toEqual({country:merchant,company,currency});
   expect(mocks.query.mock.calls[1][1]).toEqual([channel,target,company]);
   expect(mocks.list).toHaveBeenCalledWith('Item Price',expect.objectContaining({filters:{item_code:`KTG-BOOST-${channel.toUpperCase()}-${merchant}`,price_list:`KTG-CPM-${target}-${currency}`,currency},limit:2}));
   expect(result.cpmMinor).toBe(currency==='XAF'?1800:312);
  });
 }
 it('rejects an unconfigured billing profile for Lebanon',async()=>{mocks.query.mockResolvedValue({rows:[]});await expect(boostBillingContext('LB')).rejects.toThrow('BOOST_ERP_COMPANY_UNRESOLVED');});
 it('leaves shared financial country/currency rules unchanged',()=>{expect(boostMerchantCurrency('Liban')).toBe('USD');expect(()=>currencyForMerchantCountry('LB')).toThrow('COUNTRY_UNSUPPORTED');});
 it('rejects ambiguous prices instead of selecting the first',async()=>{prices.push({...prices[0],name:'IP2'});await expect(resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'EUR'})).rejects.toThrow('BOOST_PRICE_AMBIGUOUS_OR_MISSING');});
 it('rejects an item assigned to the wrong company',async()=>{item.item_defaults=[{company:'Konektag Congo'}];await expect(resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'EUR'})).rejects.toThrow('BOOST_ITEM_COMPANY_MISMATCH');});
 it('rejects a list in the wrong currency',async()=>{list.currency='XAF';await expect(resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'EUR'})).rejects.toThrow('BOOST_PRICE_CURRENCY_MISMATCH');});
 it.each([{customer:'Customer A'},{supplier:'Supplier A'},{batch_no:'B1'},{packing_unit:100},{valid_upto:'2020-01-01'},{valid_from:'2099-01-01'},{uom:'Box'}])('rejects conditional or inactive prices %j',async(condition)=>{Object.assign(prices[0],condition);await expect(resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'EUR'})).rejects.toThrow('BOOST_PRICE_CONDITIONAL');});
 it('accepts a currently valid starting date',async()=>{prices[0].valid_from='2020-01-01';expect((await resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'EUR'})).cpmMinor).toBe(312);});
 it('rejects a rate with invalid XAF precision',async()=>{list.currency='XAF';prices[0].currency='XAF';await expect(resolveBoostCpm('facebook','CG',{company:'Konektag France',currency:'XAF'})).rejects.toThrow('BOOST_PRICE_NOT_CONFIGURED');});
});
describe('admin company-scoped mapping',()=>{
 const input={channel:'facebook',targetCountry:'CG',targetCountryName:'Congo',erpnextItemCode:'KTG-BOOST-FACEBOOK-FR',priceList:'KTG-CPM-CG-EUR',billingCompany:'Konektag France',isActive:true};
 it('upserts only the selected billing company',async()=>{await saveBoostPricingMapping('actor',input);expect(mocks.admin).toHaveBeenCalledWith('actor');expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining('ON CONFLICT(channel,target_country,billing_company)'),['facebook','CG','Congo','KTG-BOOST-FACEBOOK-FR','KTG-CPM-CG-EUR',true,'actor','Konektag France']);});
 it('rejects a syntactically valid but non-ISO country',async()=>{await expect(saveBoostPricingMapping('actor',{...input,targetCountry:'ZZ'})).rejects.toThrow('INVALID_TARGET_COUNTRY');});
 it('requires an explicit billing company',async()=>{await expect(saveBoostPricingMapping('actor',{...input,billingCompany:''})).rejects.toThrow('INVALID_BILLING_COMPANY');});
});

describe('target country visibility',()=>{
 it('keeps free campaigns accessible if billing is not configured',async()=>{mocks.manager.mockResolvedValue({country:'LB'});mocks.query.mockResolvedValue({rows:[]});expect(await listSocialBoostTargetCountries('actor','merchant')).toEqual({targetCountries:[]});});
 it('lists targets with available prices convertible to the merchant currency',async()=>{
  mocks.manager.mockResolvedValue({country:'FR'});
  mocks.query.mockResolvedValueOnce({rows:[{company:'Konektag France',country_code:'FR'}]})
    .mockResolvedValueOnce({rows:[{code:'FR',name:'France',channels:['facebook']}]})
    .mockResolvedValueOnce({rows:[{company:'Konektag France'}]}) // explicit market owner
    .mockResolvedValueOnce({rows:[{company:'Konektag France',country_code:'FR'}]})
    .mockResolvedValueOnce({rows:[mapping]});
  const result=await listSocialBoostTargetCountries('actor','merchant');
  expect(mocks.query.mock.calls[1]).toEqual([expect.stringContaining('billing_company=$1'),[null]]);
  expect(result.targetCountries).toEqual([{code:'FR',name:'France',channels:['facebook']}]);
 });
});

describe('pricing without merchant or advertising account prerequisites',()=>{
 it('resolves Lebanon from the configured CPM profile without legal approval',async()=>{mocks.query.mockResolvedValue({rows:[{company:'Konektag Liban',country_code:'LB'}]});expect(await boostBillingContext('LB')).toEqual({country:'LB',currency:'USD',company:'Konektag Liban'});expect(mocks.query.mock.calls.every(([sql])=>!sql.includes('legal_entities')&&!sql.includes('merchant_profiles')&&!sql.includes('postiz_connections'))).toBe(true);});
 it('rejects two configured billing companies for one merchant country',async()=>{mocks.query.mockResolvedValue({rows:[{company:'Konektag Liban',country_code:'LB'},{company:'Other company',country_code:'LB'}]});await expect(boostBillingContext('LB')).rejects.toThrow('BOOST_ERP_COMPANY_UNRESOLVED');});
});
