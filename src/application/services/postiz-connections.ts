import pool from '../../infrastructure/database/pool.ts';
import {VisibilityError,visibilityId,visibilityText,visibilityAdmin,visibilityManager,visibilityTransaction} from './visibility-shared.ts';
import {allowedPostizBase,postizHttp} from './postiz-transport.ts';
export const DEFAULT_POSTIZ_CONNECTION='00000000-0000-4000-8000-000000000001';
export function isPostizPlatform(value:unknown):value is string{return typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);}
export function credentialName(value:unknown){if(typeof value!=='string'||!/^POSTIZ_API_KEY(?:_[A-Z0-9_]{1,80})?$/.test(value))throw new VisibilityError('POSTIZ_CREDENTIAL_REFERENCE_INVALID');return value;}
export function defaultChannels(){let channels:any;try{channels=JSON.parse(process.env.POSTIZ_MERCHANT_CHANNELS||'{}');}catch{throw new VisibilityError('POSTIZ_CHANNELS_INVALID',503);}
 if(!channels||Array.isArray(channels)||typeof channels!=='object'||Object.entries(channels).some(([platform,id])=>!isPostizPlatform(platform)||typeof id!=='string'||!id))throw new VisibilityError('POSTIZ_CHANNELS_INVALID',503);
 return channels as Record<string,string>;
}
export async function connection(id:string,db:any=pool,allowInactive=false){
 const {rows:[row]}=await db.query('SELECT * FROM konektag.postiz_connections WHERE id=$1',[visibilityId(id)]);
 if(!row||!allowInactive&&!row.active)throw new VisibilityError('POSTIZ_CONNECTION_UNAVAILABLE',503);
 return {...row,apiUrl:allowedPostizBase(row.is_default?process.env.POSTIZ_API_URL:row.api_url),credentialEnv:credentialName(row.credential_env)};
}
export async function connectionRequest(target:any,path:string,method='GET',body?:unknown){
 const key=process.env[credentialName(target.credentialEnv)];if(!key)throw new VisibilityError('POSTIZ_CREDENTIAL_MISSING',503);
 return postizHttp(allowedPostizBase(target.apiUrl),key,path,method,body);
}
export async function verifiedIntegration(target:any,id:string,platform:string){
 const all=await connectionRequest(target,'/integrations');if(!Array.isArray(all))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 const account=all.find((a:any)=>a.id===id&&a.identifier===platform&&!a.disabled);
 if(!account)throw new VisibilityError('POSTIZ_CHANNEL_UNAVAILABLE',409);
 return {id:String(account.id),name:String(account.name||account.id),platform};
}
export async function merchantPostizSettings(merchantId:string,db:any=pool){
 await db.query('SELECT id FROM konektag.merchant_profiles WHERE id=$1 FOR SHARE',[merchantId]);
 const {rows:[settings]}=await db.query('SELECT * FROM konektag.merchant_postiz_settings WHERE merchant_profile_id=$1 FOR SHARE',[merchantId]);
 const useDefault=!settings||settings.use_default;
 const c=await connection(useDefault?DEFAULT_POSTIZ_CONNECTION:settings.connection_id,db);
 const channels=useDefault?Object.fromEntries(Object.entries(defaultChannels()).map(([k,id])=>[k,[{id,name:'Compte Konektag — '+k}]])):settings.channels;
 return {connection:c,channels,useDefault,directPublish:!useDefault&&settings.direct_publish===true,version:settings?.version||0};
}
export function publicDestination(target:any){return target?{connectionName:target.connectionName,name:target.name,platform:target.platform,integrationId:target.integrationId,mode:target.mode,directPublish:target.directPublish}:null;}
export async function destinationsForMerchant(actor:string,merchantId:string){await visibilityManager(actor,merchantId);const s=await merchantPostizSettings(merchantId);
 const all=await connectionRequest(s.connection,'/integrations');if(!Array.isArray(all))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 return {version:s.version,useDefault:s.useDefault,directPublish:s.directPublish,connectionName:s.connection.name,
 destinations:Object.entries(s.channels as Record<string,any[]>).flatMap(([platform,accounts])=>accounts.map(a=>{const live=all.find((v:any)=>v.id===a.id&&v.identifier===platform);return {platform,integrationId:a.id,name:live?.name||a.name,disabled:!live||!!live.disabled};})) };
}
export async function resolveDestination(merchantId:string,platform:string,integrationId?:string,db:any=pool){
 const s=await merchantPostizSettings(merchantId,db),accounts=s.channels[platform];
 if(!Array.isArray(accounts)||!accounts.length)throw new VisibilityError('POSTIZ_CHANNEL_NOT_ASSIGNED',403);
 const id=integrationId||(accounts.length===1?accounts[0].id:null);
 if(!id||!accounts.some((a:any)=>a.id===id))throw new VisibilityError('POSTIZ_CHANNEL_NOT_ASSIGNED',403);
 if(!s.useDefault&&s.connection.is_default&&Object.values(defaultChannels()).includes(id))throw new VisibilityError('KONEKTAG_APPROVAL_REQUIRED',403);
 const a=await verifiedIntegration(s.connection,id,platform);
 return {connectionId:s.connection.id,connectionName:s.connection.name,apiUrl:s.connection.apiUrl,credentialEnv:s.connection.credentialEnv,
 integrationId:id,name:a.name,platform,mode:s.useDefault?'KONEKTAG':s.connection.is_default?'CLIENT_ACCOUNTS':'DEDICATED',directPublish:s.directPublish,version:s.version};
}
export async function assertCurrentDestination(merchantId:string,target:any,db:any=pool){
 const s=await merchantPostizSettings(merchantId,db);
 if(s.version!==target.version||s.connection.id!==target.connectionId||s.connection.apiUrl!==target.apiUrl||s.directPublish!==target.directPublish||
 !s.channels[target.platform]?.some((a:any)=>a.id===target.integrationId))throw new VisibilityError('POSTIZ_DESTINATION_CHANGED',409);
}
export async function frozenTarget(c:any,db:any=pool){
 if(c.destination_snapshot){const current=await connection(c.connection_id,db,true);if(current.credentialEnv!==c.destination_snapshot.credentialEnv||current.apiUrl!==c.destination_snapshot.apiUrl)throw new VisibilityError('POSTIZ_DESTINATION_CHANGED',409);return c.destination_snapshot;}
 // Historical campaigns were sent through the default connection. Never derive their target from new merchant settings.
 const current=await connection(DEFAULT_POSTIZ_CONNECTION,db,true),id=c.provider_integration_id||defaultChannels()[c.channel];
 if(!id)throw new VisibilityError('POSTIZ_LEGACY_DESTINATION_REQUIRED',409);
 const target={connectionId:current.id,connectionName:current.name,apiUrl:current.apiUrl,credentialEnv:current.credentialEnv,integrationId:id,name:'Compte Konektag — '+c.channel,platform:c.channel,mode:'KONEKTAG',directPublish:false,version:0};
 const {rows:[saved]}=await db.query('UPDATE konektag.merchant_social_campaigns SET destination_snapshot=$2::jsonb WHERE id=$1 AND destination_snapshot IS NULL RETURNING destination_snapshot',[c.id,JSON.stringify(target)]);
 if(!saved){const {rows:[latest]}=await db.query('SELECT destination_snapshot FROM konektag.merchant_social_campaigns WHERE id=$1',[c.id]);if(!latest?.destination_snapshot)throw new VisibilityError('POSTIZ_LEGACY_DESTINATION_REQUIRED',409);return latest.destination_snapshot;}return target;
}
async function configurationEvent(db:any,actor:string,action:string,connectionId:string,merchantId:string|null,payload:unknown){await db.query('INSERT INTO konektag.postiz_configuration_events(actor_id,action,connection_id,merchant_profile_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[actor,action,connectionId,merchantId,JSON.stringify(payload)]);}
export async function listConnections(actor:string){await visibilityAdmin(actor);const {rows}=await pool.query('SELECT * FROM konektag.postiz_connections ORDER BY is_default DESC,name,id');
 return {connections:rows.map((r:any)=>({...r,credentialConfigured:!!process.env[r.credential_env]}))};
}
export async function createConnection(actor:string,input:Record<string,unknown>){await visibilityAdmin(actor);const name=visibilityText(input.name,120),apiUrl=allowedPostizBase(input.apiUrl),credentialEnv=credentialName(input.credentialEnv);
 if(credentialEnv==='POSTIZ_API_KEY')throw new VisibilityError('POSTIZ_DEDICATED_CREDENTIAL_REQUIRED');
 if(!process.env[credentialEnv])throw new VisibilityError('POSTIZ_CREDENTIAL_MISSING',503);
 const target={apiUrl,credentialEnv};const accounts=await connectionRequest(target,'/integrations');if(!Array.isArray(accounts))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);
 return visibilityTransaction(async db=>{await visibilityAdmin(actor,db);const {rows:[c]}=await db.query('INSERT INTO konektag.postiz_connections(name,api_url,credential_env,created_by) VALUES($1,$2,$3,$4) RETURNING *',[name,apiUrl,credentialEnv,actor]);await configurationEvent(db,actor,'CONNECTION_CREATED',c.id,null,{name,apiUrl,credentialEnv});return c;});
}
export async function setConnectionActive(actor:string,id:string,active:unknown){if(typeof active!=='boolean')throw new VisibilityError('INVALID_ACTIVE');return visibilityTransaction(async db=>{await visibilityAdmin(actor,db);const {rows:[c]}=await db.query('UPDATE konektag.postiz_connections SET active=$2 WHERE id=$1 RETURNING *',[visibilityId(id),active]);if(!c)throw new VisibilityError('POSTIZ_CONNECTION_NOT_FOUND',404);await configurationEvent(db,actor,'CONNECTION_STATUS',id,null,{active});return {id,active};});}
export async function listConnectionAccounts(actor:string,id:string){await visibilityAdmin(actor);const c=await connection(id);const all=await connectionRequest(c,'/integrations');if(!Array.isArray(all))throw new VisibilityError('POSTIZ_RESPONSE_INVALID',502);return {accounts:all.filter((a:any)=>isPostizPlatform(a.identifier)).map((a:any)=>({id:a.id,name:a.name,platform:a.identifier,disabled:!!a.disabled}))};}
export async function adminMerchantSettings(actor:string,merchantId:string){await visibilityAdmin(actor);visibilityId(merchantId);const {rows:[s]}=await pool.query('SELECT * FROM konektag.merchant_postiz_settings WHERE merchant_profile_id=$1',[merchantId]);return {settings:s||null};}
export async function saveMerchantSettings(actor:string,merchantId:string,input:Record<string,unknown>){
 await visibilityAdmin(actor);visibilityId(merchantId);if(typeof input.useDefault!=='boolean'||typeof input.directPublish!=='boolean'||!Number.isInteger(input.expectedVersion))throw new VisibilityError('INVALID_SETTINGS');
 const useDefault=input.useDefault,id=useDefault?DEFAULT_POSTIZ_CONNECTION:visibilityId(input.connectionId),c=await connection(id);
 if(useDefault&&input.directPublish)throw new VisibilityError('KONEKTAG_APPROVAL_REQUIRED',403);
 const channels:Record<string,any[]>={};
 if(!useDefault){const selected=input.accounts;if(!Array.isArray(selected)||!selected.length||selected.length>10)throw new VisibilityError('POSTIZ_ACCOUNTS_REQUIRED');
 const result=await listConnectionAccounts(actor,id);const used=new Set();
 for(const value of selected){if(typeof value!=='string'||used.has(value))throw new VisibilityError('INVALID_ACCOUNT');used.add(value);if(c.is_default&&Object.values(defaultChannels()).includes(value))throw new VisibilityError('KONEKTAG_APPROVAL_REQUIRED',403);const a=result.accounts.find((a:any)=>a.id===value&&!a.disabled);if(!a)throw new VisibilityError('POSTIZ_CHANNEL_UNAVAILABLE',409);(channels[a.platform]||=[]).push({id:a.id,name:a.name});}}
 return visibilityTransaction(async db=>{await visibilityAdmin(actor,db);
 const {rows:profiles}=await db.query('SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[merchantId]);if(!profiles.length)throw new VisibilityError('MERCHANT_NOT_FOUND',404);
 const {rows:[old]}=await db.query('SELECT * FROM konektag.merchant_postiz_settings WHERE merchant_profile_id=$1 FOR UPDATE',[merchantId]);if((old?.version||0)!==input.expectedVersion)throw new VisibilityError('POSTIZ_SETTINGS_VERSION_CONFLICT',409);
 await connection(id,db);
 const {rows:[saved]}=await db.query(`INSERT INTO konektag.merchant_postiz_settings(merchant_profile_id,connection_id,channels,direct_publish,use_default,updated_by)
 VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(merchant_profile_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,channels=EXCLUDED.channels,direct_publish=EXCLUDED.direct_publish,use_default=EXCLUDED.use_default,updated_by=EXCLUDED.updated_by,version=merchant_postiz_settings.version+1,updated_at=now() RETURNING *`,[merchantId,id,JSON.stringify(channels),!useDefault&&input.directPublish,useDefault,actor]);
 await configurationEvent(db,actor,'MERCHANT_DESTINATIONS',c.id,merchantId,{version:saved.version,channels,directPublish:saved.direct_publish,useDefault});return {settings:saved};
 });
}
