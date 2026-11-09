import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import {boostBillingContext,boostMerchantCountry,resolveTargetBoostCpm,convertBoostCpm} from './merchant-social-boost-price-resolver.ts';
import {visibilityAdmin,visibilityId,visibilityManager,visibilityTransaction,VisibilityError} from './visibility-shared.ts';
import {majorToMinor,minorDecimal} from './pay/money-unit.ts';
import {isPostizPlatform} from './postiz-connections.ts';

async function boostEvent(db:any,boostId:string,targetId:string|null,actor:string|null,action:string,payload:unknown={}){
 await db.query('INSERT INTO konektag.merchant_social_boost_events(boost_id,target_id,actor_id,action,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[boostId,targetId,actor,action,JSON.stringify(payload)]);
}
async function targetCountries(db:any=pool,company:string|null=null):Promise<Array<{code:string;name:string;channels:string[]}>>{
  const {rows}=await db.query(`SELECT target_country AS code,max(target_country_name) AS name,
      array_agg(DISTINCT channel ORDER BY channel) AS channels
    FROM konektag.merchant_social_boost_pricing WHERE is_active=TRUE AND billing_company IS NOT NULL AND ($1::text IS NULL OR billing_company=$1)
    GROUP BY target_country ORDER BY max(target_country_name),target_country`,[company]);
  return rows.map((row:any)=>({code:String(row.code).trim().toUpperCase(),name:String(row.name).trim(),channels:row.channels||[]}));
}
async function selectedCountries(input:Record<string,unknown>,db:any=pool){
  const available=await targetCountries(db),requested=Array.isArray(input.targetCountries)?[...new Set(input.targetCountries.map(v=>String(v).toUpperCase()))]:[];
  if(!requested.length||requested.some(code=>!available.some(c=>c.code===code)))throw new VisibilityError('BOOST_TARGET_COUNTRY_UNAVAILABLE',422);
  return requested.sort();
}
async function selectedCampaigns(base:any,input:Record<string,unknown>,db:any=pool):Promise<any[]>{
  // A boost requested from a post applies only to that post.
  // Reject extra campaign IDs rather than silently charging for other posts.
  if(input.campaignIds!==undefined&&(!Array.isArray(input.campaignIds)||
    input.campaignIds.some(id=>String(id)!==base.id)))throw new VisibilityError('BOOST_MULTIPLE_CAMPAIGNS_NOT_ALLOWED',422);
  const ids=[base.id];
  if(ids.length>20)throw new VisibilityError('BOOST_TARGET_LIMIT_EXCEEDED',422);
  const normalized=ids.map(visibilityId);
  const {rows}=await db.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[normalized]);
  if(rows.length!==normalized.length||rows.some((c:any)=>c.boost_required!==base.boost_required)||rows.some((c:any)=>c.merchant_profile_id!==base.merchant_profile_id||
    !['DRAFT','APPROVED'].includes(c.state)||c.provider_post_id||!isPostizPlatform(c.channel)||c.destination_snapshot?.platform!==c.channel))
    throw new VisibilityError('BOOST_CAMPAIGNS_MUST_BE_UNPUBLISHED_SAME_MERCHANT',409);
  return rows;
}
async function quoteValues(campaigns:any[],countries:string[],budgetMajor:unknown){
  const merchantId=campaigns[0].merchant_profile_id;
  const {rows:[merchant]}=await pool.query('SELECT country FROM konektag.merchant_profiles WHERE id=$1',[merchantId]);
  const context=await boostBillingContext(merchant?.country);
  const currency=context.currency;
  let budgetMinor:number;try{budgetMinor=majorToMinor(String(budgetMajor??''),currency);}catch{throw new VisibilityError('INVALID_BOOST_BUDGET');}
  if(!Number.isSafeInteger(budgetMinor)||budgetMinor<100)throw new VisibilityError('INVALID_BOOST_BUDGET');
  const cells=campaigns.flatMap(c=>countries.map(country=>({campaign:c,country})));
  if(budgetMinor<cells.length)throw new VisibilityError('INVALID_BOOST_BUDGET');
  const spendPerCell=Math.floor(budgetMinor/cells.length),remainder=budgetMinor%cells.length;
  const pricingSnapshot:any[]=[];
  for(let index=0;index<cells.length;index++){
    const {campaign,country}=cells[index];
    const targetPrice=await resolveTargetBoostCpm(campaign.channel,country);
    const {mapping}=targetPrice;
    const cpmMinor=await convertBoostCpm(targetPrice.cpmMinor,targetPrice.currency,currency);
    const cellBudget=spendPerCell+(index<remainder?1:0);
    pricingSnapshot.push({campaign_id:campaign.id,channel:campaign.channel,target_country:country,target_country_name:mapping.target_country_name,
      item_code:mapping.erpnext_item_code,billing_company:targetPrice.company,price_list:mapping.price_list,currency,cpm_minor:cpmMinor,budget_minor:cellBudget,theoretical_impressions:Math.floor(cellBudget/cpmMinor*1000)});
  }
  const impressions=pricingSnapshot.reduce((sum,line)=>sum+line.theoretical_impressions,0);
  const canonical=JSON.stringify({campaignIds:campaigns.map(c=>c.id).sort(),countries,budgetMinor,currency,pricingSnapshot});
  const quoteKey=crypto.createHash('sha256').update(canonical).digest('hex');
  return {currency,budgetMinor,impressions,pricingSnapshot,quoteKey};
}
export async function listSocialBoostTargetCountries(actor:string,merchantId:string){
  const merchant=await visibilityManager(actor,merchantId);
  let context;
  try{context=await boostBillingContext(merchant.country);}catch(error){
    if(['BOOST_ERP_COMPANY_UNRESOLVED','COUNTRY_UNSUPPORTED','COUNTRY_REQUIRED'].includes((error as Error).message))return {targetCountries:[]};
    throw error;
  }
  const configured=await targetCountries();
  const targetCountriesWithPrices=[];
  for(const target of configured){
    const channels=[];
    for(const channel of target.channels){
      try{
        const price=await resolveTargetBoostCpm(channel,target.code);
        await convertBoostCpm(price.cpmMinor,price.currency,context.currency);
        channels.push(channel);
      }catch(error){
        console.warn('[merchant-boost] target CPM unavailable',{targetCountry:target.code,channel,
          reason:error&&typeof error==='object'&&'code' in error?String(error.code):'CPM_RESOLUTION_FAILED'});
      }
    }
    if(channels.length)targetCountriesWithPrices.push({...target,channels});
  }
  return {targetCountries:targetCountriesWithPrices};
}
export async function quoteSocialBoost(actor:string,campaignId:string,input:Record<string,unknown>){
  const id=visibilityId(campaignId);
  const {rows:[base]}=await pool.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=$1',[id]);
  if(!base)throw new VisibilityError('CAMPAIGN_NOT_FOUND',404);
  await visibilityManager(actor,base.merchant_profile_id);
  const campaigns=await selectedCampaigns(base,input),countries=await selectedCountries(input);
  const quote=await quoteValues(campaigns,countries,input.budgetMajor);
  return {campaignId:id,campaignIds:campaigns.map(c=>c.id),channels:[...new Set(campaigns.map(c=>c.channel))],targetCountries:countries,
    currency:quote.currency,budget_minor:quote.budgetMinor,theoretical_impressions:quote.impressions,
    pricing:quote.pricingSnapshot,quote_key:quote.quoteKey};
}
export async function requestSocialBoost(actor:string,campaignId:string,input:Record<string,unknown>){
  const id=visibilityId(campaignId);
  return visibilityTransaction(async db=>{
    const {rows:[base]}=await db.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=$1 FOR UPDATE',[id]);
    if(!base)throw new VisibilityError('CAMPAIGN_NOT_FOUND',404);
    await visibilityManager(actor,base.merchant_profile_id,db);
    const campaigns=await selectedCampaigns(base,input,db),countries=await selectedCountries(input,db);
    for(const campaign of [...campaigns].sort((a,b)=>a.id.localeCompare(b.id)))await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['social-boost-campaign:'+campaign.id]);
    const {rows:used}=await db.query('SELECT DISTINCT campaign_id FROM konektag.merchant_social_boost_targets WHERE campaign_id=ANY($1::uuid[])',[campaigns.map(c=>c.id)]);
    if(used.length)throw new VisibilityError('BOOST_CAMPAIGN_ALREADY_LINKED',409);
    const quote=await quoteValues(campaigns,countries,input.budgetMajor);
    if(typeof input.quoteKey!=='string'||input.quoteKey!==quote.quoteKey)throw new VisibilityError('BOOST_QUOTE_CHANGED',409);
    const boostId=crypto.randomUUID(),channels=[...new Set(campaigns.map(c=>c.channel))];
    const {rows:[boost]}=await db.query(`INSERT INTO konektag.merchant_social_boosts
      (id,campaign_id,merchant_profile_id,requested_by,channels,budget_minor,currency,service_price_minor,theoretical_impressions,pricing_snapshot,status)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,0,$8,$9::jsonb,'QUOTED') ON CONFLICT(campaign_id) DO NOTHING RETURNING *`,
      [boostId,base.id,base.merchant_profile_id,actor,JSON.stringify(channels),quote.budgetMinor,quote.currency,
       quote.impressions,JSON.stringify(quote.pricingSnapshot)]);
    if(!boost)throw new VisibilityError('BOOST_ALREADY_REQUESTED',409);
    const targets=[];
    for(const line of quote.pricingSnapshot){
      const campaign=campaigns.find(c=>c.id===line.campaign_id),targetId=crypto.randomUUID();
      const tracked=new URL(campaign.public_snapshot.url);
      tracked.searchParams.set('ksid',targetId);tracked.searchParams.set('utm_source',campaign.channel);
      tracked.searchParams.set('utm_medium','paid_social');tracked.searchParams.set('utm_campaign','merchant_boost');
      tracked.searchParams.set('utm_content',targetId);
      const {rows:[target]}=await db.query(`INSERT INTO konektag.merchant_social_boost_targets
        (id,boost_id,campaign_id,channel,target_country,target_country_name,budget_minor,cpm_minor,item_code,theoretical_impressions,tracking_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [targetId,boost.id,campaign.id,campaign.channel,line.target_country,line.target_country_name,line.budget_minor,line.cpm_minor,line.item_code,line.theoretical_impressions,tracked.href]);
      targets.push(target);await boostEvent(db,boost.id,target.id,actor,'CREATED',{campaignId:campaign.id,channel:campaign.channel,targetCountry:line.target_country});
    }
    const first=targets[0];
    const {rows:[saved]}=await db.query('UPDATE konektag.merchant_social_boosts SET tracking_url=$2 WHERE id=$1 RETURNING *',[boost.id,first?.tracking_url||null]);
    await boostEvent(db,boost.id,null,actor,'CREATED',{status:'QUOTED',targetCount:targets.length});return {...saved,targets};
  });
}

export async function listSocialBoosts(actor:string,merchantId?:string){
  if(merchantId)await visibilityManager(actor,merchantId);else await visibilityAdmin(actor);
  const {rows}=await pool.query(`SELECT b.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('action',e.action,'target_id',e.target_id,'payload',e.payload,'created_at',e.created_at) ORDER BY e.created_at,e.id) FROM konektag.merchant_social_boost_events e WHERE e.boost_id=b.id),'[]'::jsonb) AS history,c.channel AS post_channel,c.provider_post_id,c.provider_url,c.tracked_url,
    c.state AS post_state,c.destination_snapshot,c.created_at AS campaign_created_at,
    COALESCE((SELECT count(*) FROM konektag.profile_analytics a
      WHERE a.profile_id=b.merchant_profile_id AND a.share_id=b.id AND a.event_type='share_return'),0)::int
      + COALESCE((SELECT sum((SELECT count(*) FROM konektag.profile_analytics a WHERE a.profile_id=b.merchant_profile_id
          AND a.share_id=t.id AND a.event_type='share_return')) FROM konektag.merchant_social_boost_targets t WHERE t.boost_id=b.id),0)::int AS visits,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'campaign_id',t.campaign_id,'channel',t.channel,
      'target_country',t.target_country,'target_country_name',t.target_country_name,'budget_minor',t.budget_minor,'cpm_minor',t.cpm_minor,'item_code',t.item_code,
      'theoretical_impressions',t.theoretical_impressions,'tracking_url',t.tracking_url,'visits',
      (SELECT count(*)::int FROM konektag.profile_analytics a WHERE a.profile_id=b.merchant_profile_id
       AND a.share_id=t.id AND a.event_type='share_return'),'provider_url',tc.provider_url,'post_state',tc.state,
      'starts_at',t.starts_at,'ends_at',t.ends_at,'status',t.status,'destination_snapshot',jsonb_build_object('connectionName',tc.destination_snapshot->>'connectionName','name',tc.destination_snapshot->>'name','platform',tc.destination_snapshot->>'platform','integrationId',tc.destination_snapshot->>'integrationId','mode',tc.destination_snapshot->>'mode')) ORDER BY t.target_country,t.channel)
      FROM konektag.merchant_social_boost_targets t JOIN konektag.merchant_social_campaigns tc ON tc.id=t.campaign_id
      WHERE t.boost_id=b.id),'[]'::jsonb) AS targets
    FROM konektag.merchant_social_boosts b JOIN konektag.merchant_social_campaigns c ON c.id=b.campaign_id
    WHERE ($1::uuid IS NULL OR b.merchant_profile_id=$1) ORDER BY b.created_at DESC LIMIT 100`,[merchantId||null]);
  return {boosts:rows};
}

export async function administerSocialBoost(actor:string,boostId:string,input:Record<string,unknown>){
  await visibilityAdmin(actor);
  const id=visibilityId(boostId),action=String(input.action||'');
  const {rows:[boost]}=await pool.query(`SELECT b.*,to_jsonb(c) AS campaign FROM konektag.merchant_social_boosts b
    JOIN konektag.merchant_social_campaigns c ON c.id=b.campaign_id WHERE b.id=$1`,[id]);
  if(!boost)throw new VisibilityError('BOOST_NOT_FOUND',404);
  if(action!=='payment-link'&&Number(input.expectedVersion)!==boost.version)throw new VisibilityError('BOOST_VERSION_CONFLICT',409);
  if(action==='payment-link'){
    const lockClient=await pool.connect(),lockKey='social-boost-link:'+id;
    try{
      await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey]);
      const {rows:[current]}=await lockClient.query(`SELECT b.*,to_jsonb(c) AS campaign FROM konektag.merchant_social_boosts b
        JOIN konektag.merchant_social_campaigns c ON c.id=b.campaign_id WHERE b.id=$1`,[id]);
      if(!current)throw new VisibilityError('BOOST_NOT_FOUND',404);
      if(current.status==='PAYMENT_PENDING'&&current.payment_link)return current;
      if(Number(input.expectedVersion)!==current.version)throw new VisibilityError('BOOST_VERSION_CONFLICT',409);
      if(current.status!=='QUOTED')throw new VisibilityError('BOOST_STATE_CONFLICT',409);
      const {rows:[readiness]}=await lockClient.query(`SELECT bool_and(c.state='PUBLISHED' AND c.provider_url IS NOT NULL) AS ready
        FROM konektag.merchant_social_boost_targets t JOIN konektag.merchant_social_campaigns c ON c.id=t.campaign_id
        WHERE t.boost_id=$1`,[id]);
      // Additional publications must be paid before graphic production and scheduling.
      // Legacy Boosts keep their existing post-first payment flow.
      const {rows:[targetReadiness]}=await lockClient.query(`SELECT bool_and(c.boost_required) AS all_prepaid,
        bool_and(c.state='PUBLISHED' AND c.provider_url IS NOT NULL) AS all_published
        FROM konektag.merchant_social_boost_targets t
        JOIN konektag.merchant_social_campaigns c ON c.id=t.campaign_id
        WHERE t.boost_id=$1`,[id]);
      if(!targetReadiness?.all_prepaid&&!targetReadiness?.all_published)throw new VisibilityError('ALL_BOOST_POSTS_MUST_BE_PUBLISHED',409);
      const profileMap=JSON.parse(process.env.KONEKTAG_BOOST_PAYMENT_PROFILES||'{}');
      const {rows:[merchant]}=await lockClient.query('SELECT country FROM konektag.merchant_profiles WHERE id=$1',[current.merchant_profile_id]);
      const paymentProfile=profileMap[boostMerchantCountry(merchant?.country)];
      if(!paymentProfile)throw new VisibilityError('BOOST_PAYMENT_PROFILE_UNCONFIGURED',503);
      const {paymentLinkService}=await import('./payment-link-service.ts');
      const link=await paymentLinkService.create({merchantProfileId:String(paymentProfile),amountMinor:Number(current.budget_minor),currency:current.currency,description:'Boost social Konektag',reference:'BOOST:'+current.id,idempotencyKey:'BOOST-LINK-'+current.id,expiration:new Date(Date.now()+7*86400000)});
      const {rows:[saved]}=await lockClient.query(`UPDATE konektag.merchant_social_boosts SET status='PAYMENT_PENDING',payment_link=$2,
        payment_reference=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$4 RETURNING *`,[id,`/pay/l/${link.url_slug}`,link.url_slug,current.version]);
      if(!saved)throw new VisibilityError('BOOST_VERSION_CONFLICT',409);
      await boostEvent(lockClient,id,null,actor,'PAYMENT_LINK_CREATED',{paymentReference:link.url_slug,amountMinor:current.budget_minor,currency:current.currency});return saved;
    }finally{
      try{await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);}
      finally{lockClient.release();}
    }
  }
  if(action==='erp-sync'){if(!['PAID','CONFIGURED','BOOSTED','COMPLETED'].includes(boost.status))throw new VisibilityError('BOOST_STATE_CONFLICT',409);return recordBoostSale(boost.id);}
  if(action==='configure'){
    if(!['PAID','CONFIGURED'].includes(boost.status))throw new VisibilityError('BOOST_PAYMENT_REQUIRED',409);
    if(!Array.isArray(input.targets))throw new VisibilityError('BOOST_TARGET_PERIODS_REQUIRED',422);
    const db=await pool.connect();try{await db.query('BEGIN');const {rows:[locked]}=await db.query('SELECT * FROM konektag.merchant_social_boosts WHERE id=$1 FOR UPDATE',[id]);if(!locked||locked.version!==boost.version||!['PAID','CONFIGURED'].includes(locked.status))throw new VisibilityError('BOOST_VERSION_CONFLICT',409);
      const {rows:existing}=await db.query('SELECT id,status FROM konektag.merchant_social_boost_targets WHERE boost_id=$1 ORDER BY id FOR UPDATE',[id]);if(existing.some((t:any)=>!['CREATED','SCHEDULED'].includes(t.status)))throw new VisibilityError('BOOST_TARGET_ALREADY_PUBLISHED',409);
      const values=new Map(input.targets.map((t:any)=>[visibilityId(t.id),t]));if(values.size!==existing.length||existing.some((t:any)=>!values.has(t.id)))throw new VisibilityError('BOOST_TARGET_PERIODS_REQUIRED',422);
      for(const target of existing){const value:any=values.get(target.id),start=new Date(String(value.startsAt)),end=new Date(String(value.endsAt));if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>=end||end.getTime()<=Date.now())throw new VisibilityError('INVALID_BOOST_PERIOD',422);
        const {rows:[savedTarget]}=await db.query(`UPDATE konektag.merchant_social_boost_targets SET starts_at=$2,ends_at=$3,status='SCHEDULED' WHERE id=$1 RETURNING *`,[target.id,start.toISOString(),end.toISOString()]);await boostEvent(db,id,target.id,actor,'SCHEDULED',{startsAt:savedTarget.starts_at,endsAt:savedTarget.ends_at});}
      const {rows:[saved]}=await db.query(`UPDATE konektag.merchant_social_boosts SET status='CONFIGURED',version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id]);await boostEvent(db,id,null,actor,'CONFIGURED',{targetCount:existing.length});await db.query('COMMIT');return saved;
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  if(action==='target-published'){
    if(!['CONFIGURED','BOOSTED'].includes(boost.status))throw new VisibilityError('BOOST_STATE_CONFLICT',409);
    const targetId=visibilityId(input.targetId),client=await pool.connect();try{await client.query('BEGIN');
      const {rows:[locked]}=await client.query('SELECT * FROM konektag.merchant_social_boosts WHERE id=$1 FOR UPDATE',[id]);
      if(!locked||locked.version!==boost.version||!['CONFIGURED','BOOSTED'].includes(locked.status))throw new VisibilityError('BOOST_VERSION_CONFLICT',409);
      const {rows:[target]}=await client.query('SELECT * FROM konektag.merchant_social_boost_targets WHERE id=$1 AND boost_id=$2 FOR UPDATE',[targetId,id]);
      if(!target||target.status!=='SCHEDULED'||!target.starts_at||!target.ends_at||new Date(target.starts_at).getTime()>Date.now()||new Date(target.ends_at).getTime()<=Date.now())throw new VisibilityError('BOOST_TARGET_NOT_IN_SCHEDULED_PERIOD',409);
      const {rows:[savedTarget]}=await client.query(`UPDATE konektag.merchant_social_boost_targets SET status='PUBLISHED' WHERE id=$1 RETURNING *`,[targetId]);
      const {rows:[saved]}=await client.query(`UPDATE konektag.merchant_social_boosts SET status='BOOSTED',boosted_at=COALESCE(boosted_at,now()),admin_note=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,String(input.note||'').slice(0,1000)]);
      await boostEvent(client,id,targetId,actor,'PUBLISHED',{startsAt:savedTarget.starts_at,endsAt:savedTarget.ends_at});await client.query('COMMIT');return saved;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  if(action==='complete'){
    if(boost.status!=='BOOSTED')throw new VisibilityError('BOOST_STATE_CONFLICT',409);
    const {rows:[readiness]}=await pool.query(`SELECT bool_and(status='PUBLISHED') AS ready FROM konektag.merchant_social_boost_targets WHERE boost_id=$1`,[id]);if(!readiness?.ready)throw new VisibilityError('BOOST_TARGETS_NOT_ALL_PUBLISHED',409);
    const {rows:[saved]}=await pool.query(`UPDATE konektag.merchant_social_boosts SET status='COMPLETED',completed_at=now(),
      admin_note=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *`,[id,String(input.note||'').slice(0,1000),boost.version]);
    await pool.query(`UPDATE konektag.merchant_social_boost_targets SET status='COMPLETED' WHERE boost_id=$1`,[id]);await boostEvent(pool,id,null,actor,'COMPLETED',{});return saved;
  }
  throw new VisibilityError('INVALID_ACTION',400);
}

async function recordBoostSale(boostId:string){
  const lockClient=await pool.connect(),lockKey='social-boost-erp:'+boostId;
  try{
    await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey]);
    const {rows:[boost]}=await pool.query(`SELECT b.*,m.country,to_jsonb(c) AS campaign FROM konektag.merchant_social_boosts b
        JOIN konektag.merchant_profiles m ON m.id=b.merchant_profile_id JOIN konektag.merchant_social_campaigns c ON c.id=b.campaign_id
        WHERE b.id=$1`,[boostId]);
      if(!boost)throw new VisibilityError('BOOST_NOT_FOUND',404);
      const merchantCountry=boostMerchantCountry(boost.country);
      const {rows:entities}=await pool.query(`SELECT frappe_company,country_code FROM konektag.legal_entities
        WHERE country_code=$1 AND status='APPROVED' AND deleted_at IS NULL AND frappe_company IS NOT NULL ORDER BY code`,[merchantCountry]);
      if(entities.length!==1)throw new VisibilityError('BOOST_ERP_COMPANY_UNRESOLVED',503);
      const customerMap=JSON.parse(process.env.KONEKTAG_BOOST_ERP_CUSTOMERS||'{}');
      const customer=customerMap[merchantCountry];if(!customer)throw new VisibilityError('BOOST_ERP_CUSTOMER_UNCONFIGURED',503);
      const {erpnext}=await import('../../infrastructure/adapters/erpnext-adapter.ts');
      const poNo='KONEKTAG-BOOST-'+boost.id;
      const existing=await erpnext.listAdvanced('Sales Invoice',{filters:{po_no:poNo},fields:['name','docstatus'],limit:1});
      let invoice=existing?.[0];
      if(!invoice){
        const frozenPricing=Array.isArray(boost.pricing_snapshot)?boost.pricing_snapshot:[];
        if(frozenPricing.some((line:any)=>line.billing_company&&line.billing_company!==entities[0].frappe_company))throw new VisibilityError('BOOST_ERP_COMPANY_UNRESOLVED',503);
        if(!frozenPricing.length)throw new VisibilityError('BOOST_PRICING_SNAPSHOT_MISSING',409);
        const items=frozenPricing.map((line:any)=>{
          const rate=Number(minorDecimal(Number(line.cpm_minor),boost.currency));
          const lineBudget=Number(line.budget_minor);
          if(!Number.isFinite(rate)||rate<=0||!Number.isSafeInteger(lineBudget)||lineBudget<0)throw new VisibilityError('BOOST_PRICING_SNAPSHOT_INVALID',409);
          return {item_code:String(line.item_code),qty:Number(minorDecimal(lineBudget,boost.currency))/rate,rate};
        });
        invoice=await erpnext.create('Sales Invoice',{company:entities[0].frappe_company,customer,posting_date:new Date().toISOString().slice(0,10),due_date:new Date().toISOString().slice(0,10),po_no:poNo,remarks:'Boost manuel Konektag '+boost.id,items});
      }
      const name=invoice.name||invoice;
      if(Number(invoice.docstatus||0)!==1)await erpnext.submit('Sales Invoice',name);
      const {rows:[saved]}=await pool.query(`UPDATE konektag.merchant_social_boosts SET erp_invoice=$2,erp_error=NULL,erp_synced_at=now(),
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[boost.id,name]);
      return saved;
  }finally{
    try{await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]);}
    finally{lockClient.release();}
  }
}

export async function markSocialBoostPaid(reference:string){
  const {rows:[boost]}=await pool.query(`UPDATE konektag.merchant_social_boosts SET status='PAID',paid_at=now(),
    version=version+1,updated_at=now() WHERE payment_reference=$1 AND status='PAYMENT_PENDING' RETURNING *`,[reference]);
  if(!boost)return null;
  await boostEvent(pool,boost.id,null,null,'PAID',{paymentReference:reference,paidAt:boost.paid_at});
  try{return await recordBoostSale(boost.id);}catch(error){
    await pool.query(`UPDATE konektag.merchant_social_boosts SET erp_error=$2,updated_at=now() WHERE id=$1`,[boost.id,String((error as Error)?.message||'ERP_SYNC_FAILED').slice(0,500)]);
    return boost;
  }
}
