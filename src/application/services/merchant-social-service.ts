import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import {VisibilityError,visibilityId,visibilityText,visibilityManager,visibilityAdmin,visibilityTransaction,publishedMerchant,publicSite,fingerprint} from './visibility-shared.ts';
import {isPostizPlatform,DEFAULT_POSTIZ_CONNECTION,defaultChannels,connection,connectionRequest,verifiedIntegration,resolveDestination,assertCurrentDestination,frozenTarget,publicDestination,destinationsForMerchant} from './postiz-connections.ts';
export const socialChannels=defaultChannels;
function creativeBrief(input:unknown){
 const raw=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
 const field=(name:string,max:number)=>{const value=raw[name];if(value!=null&&typeof value!=='string')throw new VisibilityError('INVALID_CREATIVE_BRIEF',422);const text=String(value||'').trim();if(text.length>max)throw new VisibilityError('INVALID_CREATIVE_BRIEF',422);return text;};
 const kind=field('kind',40),style=field('style',60);
 if(kind&&!['promotion','event','news','business','other'].includes(kind))throw new VisibilityError('INVALID_CREATIVE_BRIEF',422);
 return {kind,title:field('title',140),message:field('message',1800),instructions:field('instructions',2000),style,referenceUrl:field('referenceUrl',2000)};
}
function hasCreativeBrief(b:ReturnType<typeof creativeBrief>){return Object.values(b).some(Boolean);}

// Compatibility for server-side consumers; campaigns always use their own frozen target.
export async function postizRequest(path:string,method='GET',body?:unknown){return connectionRequest(await connection(DEFAULT_POSTIZ_CONNECTION),path,method,body);}
export function campaignLink(url:string,id:string,channel:string){const u=new URL(url);u.searchParams.set('ksid',id);u.searchParams.set('utm_source',channel);u.searchParams.set('utm_medium','social');u.searchParams.set('utm_campaign','merchant_promotion');return u.href;}
export async function campaignEvent(db:any,id:string,actor:string|null,action:string,version:number,payload:unknown={}){await db.query('INSERT INTO konektag.merchant_social_campaign_events(campaign_id,actor_id,action,version,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[id,actor,action,version,JSON.stringify(payload)]);}
function period(input:Record<string,unknown>,prefix:'marketplace'|'channel',existing?:any){
 const startValue=input[prefix+'StartsAt'],endValue=input[prefix+'EndsAt'];
 if(startValue===undefined&&endValue===undefined)return {start:existing?.[prefix+'_starts_at']||null,end:existing?.[prefix+'_ends_at']||null};
 if((!startValue&&endValue)||(!endValue&&startValue))throw new VisibilityError('INVALID_PUBLICATION_PERIOD',422);
 if(!startValue&&!endValue)return {start:null,end:null};
 const start=new Date(String(startValue)),end=new Date(String(endValue));
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>=end)throw new VisibilityError('INVALID_PUBLICATION_PERIOD',422);
 return {start:start.toISOString(),end:end.toISOString()};
}
function sameInstant(a:any,b:any){return a==null?b==null:b!=null&&new Date(a).getTime()===new Date(b).getTime();}
function campaignPeriods(input:Record<string,unknown>,existing?:any){
 const marketplace=period(input,'marketplace',existing),channel=period(input,'channel',existing);
 return {marketplaceStart:marketplace.start,marketplaceEnd:marketplace.end,channelStart:channel.start,channelEnd:channel.end};
}
async function campaign(db:any,id:string){const {rows:[c]}=await db.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=$1 FOR UPDATE',[visibilityId(id)]);if(!c)throw new VisibilityError('CAMPAIGN_NOT_FOUND',404);return c;}
function version(c:any,v:unknown){if(!Number.isInteger(v)||c.version!==v)throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);}
function publicCampaign(c:any){return {...c,destination_snapshot:publicDestination(c.destination_snapshot)};}
export async function prepareCampaign(actor:string,merchantId:string,input:Record<string,unknown>,requestKey:unknown){
 const key=visibilityId(requestKey),channel=String(input.channel);if(!isPostizPlatform(channel))throw new VisibilityError('INVALID_CHANNEL');
 if(input.integrationId!==undefined&&typeof input.integrationId!=='string')throw new VisibilityError('INVALID_ACCOUNT');
 return visibilityTransaction(async db=>{await visibilityManager(actor,merchantId,db);const snapshot=await publishedMerchant(merchantId,db);if(!snapshot.description)throw new VisibilityError('PUBLIC_PROFILE_INCOMPLETE',409);
 const brief=creativeBrief(input.creativeBrief),content=visibilityText(input.content??`Découvrez ${snapshot.businessName} à ${snapshot.city}.\n${snapshot.description}`,1800),periods=campaignPeriods(input);
 const {rows:[old]}=await db.query('SELECT * FROM konektag.merchant_social_campaigns WHERE merchant_profile_id=$1 AND request_key=$2',[merchantId,key]);
 if(old){if(JSON.stringify(old.creative_brief||{})!==JSON.stringify(brief))throw new VisibilityError('IDEMPOTENCY_CONFLICT',409);if(old.content!==content||old.channel!==channel||old.created_by!==actor||input.integrationId&&old.provider_integration_id!==input.integrationId||!sameInstant(old.marketplace_starts_at,periods.marketplaceStart)||!sameInstant(old.marketplace_ends_at,periods.marketplaceEnd)||!sameInstant(old.channel_starts_at,periods.channelStart)||!sameInstant(old.channel_ends_at,periods.channelEnd))throw new VisibilityError('IDEMPOTENCY_CONFLICT',409);return publicCampaign(old);}
 // Serialize new requests per merchant to prevent concurrent submissions bypassing the monthly allowance.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['social-publication-quota:'+merchantId]);
 const {rows:[usage]}=await db.query(`SELECT COUNT(*)::int AS used FROM konektag.merchant_social_campaigns
   WHERE merchant_profile_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
   AND created_at<date_trunc('month',(now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
   AND (state<>'CANCELLED' OR free_claimed_at IS NOT NULL) AND boost_required=FALSE AND destination_snapshot->>'mode'='KONEKTAG'`,[merchantId]);
 const boostRequired=Number(usage.used)>=2;
 const target=await resolveDestination(merchantId,channel,input.integrationId as string|undefined,db),id=crypto.randomUUID(),url=campaignLink(snapshot.url,id,channel);
 const {rows:[created]}=await db.query(`INSERT INTO konektag.merchant_social_campaigns(id,merchant_profile_id,created_by,request_key,content,channel,public_snapshot,snapshot_hash,tracked_url,connection_id,destination_snapshot,destination_version,requires_approval,provider_integration_id,marketplace_starts_at,marketplace_ends_at,channel_starts_at,channel_ends_at,creative_brief,boost_required)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20) ON CONFLICT(merchant_profile_id,request_key) DO NOTHING RETURNING *`,[id,merchantId,actor,key,content,channel,JSON.stringify(snapshot),fingerprint(snapshot),url,target.connectionId,JSON.stringify(target),target.version,hasCreativeBrief(brief)||!target.directPublish,target.integrationId,periods.marketplaceStart,periods.marketplaceEnd,periods.channelStart,periods.channelEnd,JSON.stringify(brief),boostRequired&&target.mode==='KONEKTAG']);
 if(!created){const {rows:[raced]}=await db.query('SELECT * FROM konektag.merchant_social_campaigns WHERE merchant_profile_id=$1 AND request_key=$2',[merchantId,key]);if(raced&&raced.content===content&&raced.channel===channel&&raced.created_by===actor&&raced.provider_integration_id===target.integrationId)return publicCampaign(raced);throw new VisibilityError('IDEMPOTENCY_CONFLICT',409);}
 await campaignEvent(db,id,actor,'CREATED',1,{destination:publicDestination(target),...periods});await campaignEvent(db,id,actor,'PREPARED',1,{destination:publicDestination(target),...periods});return publicCampaign(created);
 });
}
export async function editCampaign(actor:string,id:string,input:Record<string,unknown>){return visibilityTransaction(async db=>{
 const c=await campaign(db,id);await visibilityManager(actor,c.merchant_profile_id,db);version(c,input.expectedVersion);
 if(!['DRAFT','APPROVED'].includes(c.state))throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);
 const {rows:[linkedBoost]}=await db.query('SELECT id FROM konektag.merchant_social_boosts WHERE campaign_id=$1',[id]);if(linkedBoost)throw new VisibilityError('CAMPAIGN_BOOST_LOCKED',409);
 const brief=input.creativeBrief===undefined?creativeBrief(c.creative_brief):creativeBrief(input.creativeBrief);const snapshot=await publishedMerchant(c.merchant_profile_id,db),content=visibilityText(input.content,1800),channel=String(input.channel||c.channel),periods=campaignPeriods(input,c);
 if(!isPostizPlatform(channel)||input.integrationId!==undefined&&typeof input.integrationId!=='string')throw new VisibilityError('INVALID_CHANNEL');
 const target=await resolveDestination(c.merchant_profile_id,channel,input.integrationId as string|undefined,db);
 const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET content=$2,public_snapshot=$3::jsonb,snapshot_hash=$4,tracked_url=$5,state='DRAFT',approved_by=NULL,approved_at=NULL,version=version+1,updated_at=now(),channel=$6,connection_id=$7,destination_snapshot=$8::jsonb,destination_version=$9,requires_approval=$10,provider_integration_id=$11,marketplace_starts_at=$12,marketplace_ends_at=$13,channel_starts_at=$14,channel_ends_at=$15,creative_brief=$16::jsonb,final_media_url=NULL WHERE id=$1 RETURNING *`,[id,content,JSON.stringify(snapshot),fingerprint(snapshot),campaignLink(snapshot.url,id,channel),channel,target.connectionId,JSON.stringify(target),target.version,hasCreativeBrief(brief)||!target.directPublish,target.integrationId,periods.marketplaceStart,periods.marketplaceEnd,periods.channelStart,periods.channelEnd,JSON.stringify(brief)]);
 await campaignEvent(db,id,actor,'REVISED',updated.version,{destination:publicDestination(target),...periods});return publicCampaign(updated);
 });}
export async function approveCampaign(actor:string,id:string,v:unknown){return visibilityTransaction(async db=>{await visibilityAdmin(actor,db);const c=await campaign(db,id);
 if(c.state==='APPROVED'&&c.version===Number(v)+1)return publicCampaign(c);
 version(c,v);if(c.state!=='DRAFT')throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);
 if(fingerprint(await publishedMerchant(c.merchant_profile_id,db))!==c.snapshot_hash)throw new VisibilityError('PUBLIC_PROFILE_CHANGED',409);
 if(hasCreativeBrief(creativeBrief(c.creative_brief))&&!c.final_media_url)throw new VisibilityError('CAMPAIGN_FINAL_MEDIA_REQUIRED',422);
 if(c.boost_required){
  const {rows:[paid]}=await db.query("SELECT 1 FROM konektag.merchant_social_boost_targets t JOIN konektag.merchant_social_boosts b ON b.id=t.boost_id WHERE t.campaign_id=$1 AND b.status IN ('PAID','CONFIGURED','BOOSTED','COMPLETED') LIMIT 1",[id]);
  if(!paid)throw new VisibilityError('PUBLICATION_BOOST_PAYMENT_REQUIRED',402);
 }
 const target=await frozenTarget(c,db);await assertCurrentDestination(c.merchant_profile_id,target,db);await verifiedIntegration(target,target.integrationId,target.platform);
 const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state='APPROVED',approved_by=$2,approved_at=now(),destination_snapshot=$3::jsonb,connection_id=$4,provider_integration_id=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,actor,JSON.stringify(target),target.connectionId,target.integrationId]);await campaignEvent(db,id,actor,'APPROVED',updated.version,{destination:publicDestination(target)});return publicCampaign(updated);
 });}
export function socialMediaUrl(value:string){const u=new URL(value,publicSite()),origins=[publicSite(),...(process.env.PUBLIC_MEDIA_ORIGINS||'').split(',').filter(Boolean).map(v=>new URL(v.trim()).origin)];if(u.protocol!=='https:'||u.username||u.password||!origins.includes(u.origin))throw new VisibilityError('PUBLIC_IMAGE_ORIGIN_NOT_ALLOWED');return u.href;}
export async function scheduleCampaign(actor:string,id:string,input:Record<string,unknown>,asAdmin=true){
 const when=new Date(String(input.scheduledAt));if(!Number.isFinite(when.getTime())||when.getTime()<Date.now()+120000)throw new VisibilityError('SCHEDULE_AT_LEAST_TWO_MINUTES_AHEAD');
 const c=await visibilityTransaction(async db=>{
 if(asAdmin)await visibilityAdmin(actor,db);const c=await campaign(db,id);
 if(!asAdmin)await visibilityManager(actor,c.merchant_profile_id,db);
 if(['SCHEDULED','PUBLISHED'].includes(c.state)||c.provider_post_id)throw new VisibilityError('POSTIZ_ALREADY_LINKED',409);
 version(c,input.expectedVersion);
 if(c.boost_required){
   const {rows:[paid]}=await db.query("SELECT 1 FROM konektag.merchant_social_boost_targets t JOIN konektag.merchant_social_boosts b ON b.id=t.boost_id WHERE t.campaign_id=$1 AND b.status IN ('PAID','CONFIGURED','BOOSTED','COMPLETED') LIMIT 1",[id]);
   if(!paid)throw new VisibilityError('PUBLICATION_BOOST_PAYMENT_REQUIRED',402);
 }
 if(c.channel_starts_at&&when<new Date(c.channel_starts_at)||c.channel_ends_at&&when>new Date(c.channel_ends_at))throw new VisibilityError('SCHEDULE_OUTSIDE_CHANNEL_PERIOD',422);
 const target=await frozenTarget(c,db);await assertCurrentDestination(c.merchant_profile_id,target,db);
 if(!asAdmin&&(!target.directPublish||c.requires_approval!==false||target.mode==='KONEKTAG'))throw new VisibilityError('EDITORIAL_APPROVAL_REQUIRED',403);
 if(c.state!=='APPROVED'&&!(c.state==='DRAFT'&&target.directPublish&&c.requires_approval===false))throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);
 if(fingerprint(await publishedMerchant(c.merchant_profile_id,db))!==c.snapshot_hash)throw new VisibilityError('PUBLIC_PROFILE_CHANGED',409);
 if(c.channel!=='facebook'&&!(c.final_media_url||c.public_snapshot.imageUrl))throw new VisibilityError('INSTAGRAM_PUBLIC_IMAGE_REQUIRED');
 if(c.final_media_url||c.public_snapshot.imageUrl)socialMediaUrl(c.final_media_url||c.public_snapshot.imageUrl);
 await verifiedIntegration(target,target.integrationId,c.channel);
 const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state='SENDING',scheduled_at=$2,provider_integration_id=$3,destination_snapshot=$4::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,when,target.integrationId,JSON.stringify(target)]);await campaignEvent(db,id,actor,'SCHEDULING_REQUESTED',updated.version,{destination:publicDestination(target)});return updated;
 });
 if(['SCHEDULED','PUBLISHED'].includes(c.state))return publicCampaign(c);
 const target=c.destination_snapshot;let postRequestStarted=false;
 try{
 const image=[];const mediaUrl=c.final_media_url||c.public_snapshot.imageUrl;if(mediaUrl){const m=await connectionRequest(target,'/upload-from-url','POST',{url:socialMediaUrl(mediaUrl)});if(!m?.id||!m?.path)throw new VisibilityError('POSTIZ_MEDIA_INVALID');image.push({id:m.id,path:m.path});}
 // One Postiz post per campaign: deleting its Postiz group cannot cancel another campaign.
 const body={type:'schedule',date:when.toISOString(),shortLink:false,tags:[],posts:[{integration:{id:target.integrationId},value:[{content:c.content+'\n\n'+c.tracked_url,image}],settings:{__type:c.channel,post_type:'post'}}]};
 postRequestStarted=true;const result=await connectionRequest(target,'/posts','POST',body),row=Array.isArray(result)?result[0]:null;
 if(!row?.postId||row.integration!==target.integrationId)throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 return visibilityTransaction(async db=>{const {rows:[saved]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state='SCHEDULED',provider_post_id=$2,last_error=NULL,version=version+1,updated_at=now() WHERE id=$1 AND state='SENDING' RETURNING *`,[id,row.postId]);if(!saved)throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);await campaignEvent(db,id,actor,'SCHEDULED',saved.version,{postId:row.postId,scheduledAt:when.toISOString(),channelStartsAt:saved.channel_starts_at,channelEndsAt:saved.channel_ends_at});return publicCampaign(saved);});
 }catch(e){
 const uncertain=postRequestStarted&&(!(e instanceof VisibilityError)||e.status>=500),state=uncertain?'UNCERTAIN':'FAILED';
 await visibilityTransaction(async db=>{const {rows:[s]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state=$2,last_error=$3,version=version+1,updated_at=now() WHERE id=$1 AND state='SENDING' RETURNING version`,[id,state,uncertain?'POSTIZ_OUTCOME_UNKNOWN':postizErrorCode(e)]);if(s)await campaignEvent(db,id,actor,state,s.version);});
 throw new VisibilityError(uncertain?'POSTIZ_RECONCILE_REQUIRED':postizErrorCode(e),502);
 }
}
export function postizErrorCode(e:unknown){if(e instanceof VisibilityError){const code=e.code;if(/^POSTIZ_[A-Z0-9_]+$/.test(code))return code;}return 'POSTIZ_TRANSPORT_ERROR';}
async function matchingPosts(c:any,target:any){
 const t=new Date(c.scheduled_at).getTime(),qs=new URLSearchParams({startDate:new Date(t-86400000).toISOString(),endDate:new Date(t+86400000).toISOString()});
 const result=await connectionRequest(target,'/posts?'+qs);if(!Array.isArray(result?.posts))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 return result.posts.filter((p:any)=>p.integration?.id===target.integrationId&&(c.provider_post_id?p.id===c.provider_post_id:typeof p.content==='string'&&p.content.includes(c.tracked_url)));
}
/** Internal worker entry point. HTTP routes must authorize separately. Never sends or retries a publication. */
export async function reconcileCampaign(id:string,actor:string|null=null){
 const {rows:[c]}=await pool.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=$1',[visibilityId(id)]);
 if(!c||!c.scheduled_at||!c.provider_integration_id)throw new VisibilityError('CAMPAIGN_NOT_SENT',409);
 if(['CANCELLED'].includes(c.state))return publicCampaign(c);
 if(['SENDING','CANCELLING'].includes(c.state)&&Date.now()-new Date(c.updated_at).getTime()<120000)throw new VisibilityError('CAMPAIGN_BUSY',409);
 const target=await frozenTarget(c),matches=await matchingPosts(c,target),cancelling=!!c.cancellation_requested_at;
 if(matches.length!==1&&!(matches.length===0&&cancelling&&Date.now()<new Date(c.scheduled_at).getTime()))throw new VisibilityError('POSTIZ_RECONCILIATION_UNRESOLVED',409);
 const p=matches[0],state=!p?'CANCELLED':p.state==='PUBLISHED'?'PUBLISHED':cancelling?'CANCEL_UNCERTAIN':p.state==='QUEUE'?'SCHEDULED':p.state==='ERROR'?'FAILED':'UNCERTAIN';
 const url=typeof p?.releaseURL==='string'&&/^https:\/\//.test(p.releaseURL)?p.releaseURL:null;
 return visibilityTransaction(async db=>{const current=await campaign(db,id);version(current,c.version);
 if(state===c.state){await db.query('UPDATE konektag.merchant_social_campaigns SET provider_checked_at=now(),last_error=NULL WHERE id=$1',[id]);return publicCampaign({...current,provider_checked_at:new Date()});}
 const {rows:[saved]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state=$2,provider_post_id=COALESCE($3,provider_post_id),provider_url=$4,provider_checked_at=now(),last_error=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,state,p?.id||null,url]);await campaignEvent(db,id,actor,'RECONCILED',saved.version,{state});return publicCampaign(saved);});
}
export async function syncCampaign(actor:string,id:string){await visibilityAdmin(actor);return reconcileCampaign(id,actor);}
export async function cancelCampaign(actor:string,id:string,v:unknown,asAdmin=true){
 const c=await visibilityTransaction(async db=>{if(asAdmin)await visibilityAdmin(actor,db);const c=await campaign(db,id);if(!asAdmin)await visibilityManager(actor,c.merchant_profile_id,db);if(c.state==='CANCELLED')return c;version(c,v);
 // Cancellation is permitted for one's assigned campaign even after configuration changes or revocation of direct publishing.
 if(['DRAFT','APPROVED'].includes(c.state)&&!c.provider_post_id){const {rows:[linkedBoost]}=await db.query('SELECT status FROM konektag.merchant_social_boosts WHERE campaign_id=$1 FOR UPDATE',[id]);if(linkedBoost&&!['REQUESTED','QUOTED','CANCELLED'].includes(linkedBoost.status))throw new VisibilityError('BOOST_PAYMENT_ALREADY_ISSUED',409);const {rows:[saved]}=await db.query("UPDATE konektag.merchant_social_campaigns SET state='CANCELLED',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id]);await db.query("UPDATE konektag.merchant_social_boosts SET status='CANCELLED',version=version+1,updated_at=now() WHERE campaign_id=$1 AND status IN ('REQUESTED','QUOTED')",[id]);await campaignEvent(db,id,actor,'CANCELLED',saved.version);return saved;}
 if(!['SCHEDULED','CANCEL_UNCERTAIN'].includes(c.state)||!c.provider_post_id)throw new VisibilityError('POSTIZ_RECONCILE_REQUIRED',409);
 if(new Date(c.scheduled_at).getTime()<Date.now()+120000)throw new VisibilityError('POSTIZ_CANCELLATION_TOO_LATE',409);
 const {rows:[saved]}=await db.query("UPDATE konektag.merchant_social_campaigns SET state='CANCELLING',cancellation_requested_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id]);await campaignEvent(db,id,actor,'CANCELLATION_REQUESTED',saved.version);return saved;});
 if(c.state==='CANCELLED')return publicCampaign(c);
 try{const target=await frozenTarget(c),matches=await matchingPosts(c,target);
 if(matches.length!==1||matches[0].state!=='QUEUE')throw new VisibilityError('POSTIZ_RECONCILE_REQUIRED',409);
 try{await connectionRequest(target,'/posts/'+encodeURIComponent(c.provider_post_id),'DELETE');}catch(e){if(!(e instanceof VisibilityError&&e.code==='POSTIZ_HTTP_404'))throw e;}
 const remaining=await matchingPosts(c,target);if(remaining.length||Date.now()>=new Date(c.scheduled_at).getTime())throw new VisibilityError('POSTIZ_CANCELLATION_UNCONFIRMED',409);
 return visibilityTransaction(async db=>{const current=await campaign(db,id);version(current,c.version);const {rows:[saved]}=await db.query("UPDATE konektag.merchant_social_campaigns SET state='CANCELLED',provider_checked_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id]);await campaignEvent(db,id,actor,'CANCELLED',saved.version);return publicCampaign(saved);});
 }catch{await visibilityTransaction(async db=>{const {rows:[s]}=await db.query("UPDATE konektag.merchant_social_campaigns SET state='CANCEL_UNCERTAIN',last_error='POSTIZ_CANCELLATION_UNCONFIRMED',version=version+1,updated_at=now() WHERE id=$1 AND state='CANCELLING' RETURNING version",[id]);if(s)await campaignEvent(db,id,actor,'CANCEL_UNCERTAIN',s.version);});throw new VisibilityError('POSTIZ_CANCELLATION_UNCONFIRMED',409);}
}
export async function campaignList(actor:string,merchantId?:string){if(merchantId)await visibilityManager(actor,merchantId);else await visibilityAdmin(actor);
 const {rows}=await pool.query(`SELECT c.*,COALESCE(a.visits,0)::int AS visits,COALESCE(a.interactions,0)::int AS interactions,COALESCE((SELECT jsonb_agg(jsonb_build_object('action',e.action,'created_at',e.created_at,'payload',e.payload) ORDER BY e.created_at,e.id) FROM konektag.merchant_social_campaign_events e WHERE e.campaign_id=c.id),'[]'::jsonb) AS history FROM konektag.merchant_social_campaigns c
 LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE event_type='share_return') AS visits,count(*) FILTER(WHERE event_type IN ('menu_view','catalog_view','phone_click','direction_click','external_link_click','reservation_click')) AS interactions
 FROM konektag.profile_analytics WHERE profile_id=c.merchant_profile_id AND share_id=c.id) a ON true
 WHERE ($1::uuid IS NULL OR c.merchant_profile_id=$1) ORDER BY c.created_at DESC LIMIT 100`,[merchantId||null]);
 let destinations:any=null,configurationError:string|null=null;if(merchantId){try{destinations=await destinationsForMerchant(actor,merchantId);}catch(e){configurationError=postizErrorCode(e);}}
 return {campaigns:rows.map(publicCampaign),destinations,configurationError};
}
export async function resetFailedCampaign(actor:string,id:string,v:unknown){return visibilityTransaction(async db=>{await visibilityAdmin(actor,db);const c=await campaign(db,id);version(c,v);if(c.state!=='FAILED'||c.provider_post_id)throw new VisibilityError('POSTIZ_RECONCILE_REQUIRED',409);const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_social_campaigns SET state='DRAFT',approved_by=NULL,approved_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id]);await campaignEvent(db,id,actor,'RESET_FOR_REVIEW',updated.version);return publicCampaign(updated);});}

export async function setCampaignFinalMedia(actor:string,id:string,input:Record<string,unknown>){
 return visibilityTransaction(async db=>{
  await visibilityAdmin(actor,db);
  const c=await campaign(db,id);version(c,input.expectedVersion);
  if(c.state!=='DRAFT'&&c.state!=='APPROVED')throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);
  const url=String(input.mediaUrl||'').trim();
  if(url) socialMediaUrl(url);
  const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_social_campaigns
    SET final_media_url=$2,state='DRAFT',approved_by=NULL,approved_at=NULL,
        requires_approval=TRUE,version=version+1,updated_at=now()
    WHERE id=$1 RETURNING *`,[id,url||null]);
  await campaignEvent(db,id,actor,'MEDIA_UPDATED',updated.version,{hasMedia:!!url});
  return publicCampaign(updated);
 });
}
/** Administrative production start: a cancelled unclaimed request releases its reservation. */
export async function claimFreePublication(actor:string,id:string,v:unknown){
 return visibilityTransaction(async db=>{
  await visibilityAdmin(actor,db);const c=await campaign(db,id);version(c,v);
  if(c.boost_required)throw new VisibilityError('PUBLICATION_BOOST_PAYMENT_REQUIRED',402);
  if(c.destination_snapshot?.mode!=='KONEKTAG'||!['DRAFT','APPROVED'].includes(c.state))throw new VisibilityError('CAMPAIGN_VERSION_CONFLICT',409);
  if(c.free_claimed_at)return publicCampaign(c);
  const {rows:[updated]}=await db.query("UPDATE konektag.merchant_social_campaigns SET free_claimed_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id]);
  await campaignEvent(db,id,actor,'GRAPHIC_WORK_STARTED',updated.version);
  return publicCampaign(updated);
 });
}
/** Link an existing manually prepared Postiz post; never create another post. */
export async function attachManualPost(actor:string,id:string,input:Record<string,unknown>){
 await visibilityAdmin(actor);
 const postId=String(input.postId||'').trim();
 if(!postId||postId.length>200)throw new VisibilityError('POSTIZ_POST_ID_INVALID',422);
 const {rows:[existing]}=await pool.query('SELECT * FROM konektag.merchant_social_campaigns WHERE id=$1',[visibilityId(id)]);
 if(!existing)throw new VisibilityError('CAMPAIGN_NOT_FOUND',404);
 if(existing.provider_post_id===postId)return publicCampaign(existing);
 if(existing.provider_post_id||existing.state!=='APPROVED')throw new VisibilityError('EDITORIAL_APPROVAL_REQUIRED',409);
 if(existing.boost_required){
  const {rows:[paid]}=await pool.query("SELECT 1 FROM konektag.merchant_social_boost_targets t JOIN konektag.merchant_social_boosts b ON b.id=t.boost_id WHERE t.campaign_id=$1 AND b.status IN ('PAID','CONFIGURED','BOOSTED','COMPLETED') LIMIT 1",[id]);
  if(!paid)throw new VisibilityError('PUBLICATION_BOOST_PAYMENT_REQUIRED',402);
 }
 const target=await frozenTarget(existing);
 const now=Date.now(),qs=new URLSearchParams({startDate:new Date(now-30*86400000).toISOString(),endDate:new Date(now+365*86400000).toISOString()});
 const response=await connectionRequest(target,'/posts?'+qs);
 if(!Array.isArray(response?.posts))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 const matches=response.posts.filter((p:any)=>String(p.id)===postId&&p.integration?.id===target.integrationId);
 if(matches.length!==1)throw new VisibilityError('POSTIZ_POST_NOT_VERIFIED',409);
 const post=matches[0];
 if(typeof post.content!=='string'||!post.content.includes(existing.tracked_url))throw new VisibilityError('POSTIZ_TRACKING_LINK_REQUIRED',409);
 if(!['QUEUE','PUBLISHED'].includes(post.state))throw new VisibilityError('POSTIZ_POST_NOT_READY',409);
 const scheduledAt=post.date?new Date(post.date):null;
 if(!scheduledAt||!Number.isFinite(scheduledAt.getTime()))throw new VisibilityError('POSTIZ_DATE_REQUIRED',409);
 const url=typeof post.releaseURL==='string'&&/^https:\/\//.test(post.releaseURL)?post.releaseURL:null;
 return visibilityTransaction(async db=>{
  const c=await campaign(db,id);version(c,input.expectedVersion);
  if(c.provider_post_id||c.state!=='APPROVED')throw new VisibilityError('EDITORIAL_APPROVAL_REQUIRED',409);
  const {rows:[duplicate]}=await db.query('SELECT id FROM konektag.merchant_social_campaigns WHERE provider_post_id=$1 AND connection_id=$2 AND id<>$3 LIMIT 1',[postId,c.connection_id,id]);
  if(duplicate)throw new VisibilityError('POSTIZ_ALREADY_LINKED',409);
  const {rows:[saved]}=await db.query("UPDATE konektag.merchant_social_campaigns SET provider_post_id=$2,scheduled_at=$3,provider_url=$4,state=$5,provider_checked_at=now(),free_claimed_at=CASE WHEN boost_required THEN free_claimed_at ELSE COALESCE(free_claimed_at,now()) END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,postId,scheduledAt.toISOString(),url,post.state==='PUBLISHED'?'PUBLISHED':'SCHEDULED']);
  await campaignEvent(db,id,actor,'MANUAL_POST_LINKED',saved.version,{postId,state:saved.state});
  return publicCampaign(saved);
 });
}
