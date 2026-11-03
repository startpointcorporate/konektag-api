import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,actor} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(reset);
for(const method of ['GET','PUT'])describe(`[REST BUSINESS ${method} /api/profile/public]`,()=>{
 const source='profile/public';
 it('requires the real session account and returns NOT_FOUND for an absent owner',async()=>{
  const anonymous=await call(source,method,{}, {signedIn:false});expect(anonymous.status).toBe(401);expect(await anonymous.json()).toEqual({error:'UNAUTHORIZED'});expect(db.query).not.toHaveBeenCalled();
  sql(/SELECT id FROM konektag.users/);const missing=await call(source,method,{});expect(missing.status).toBe(404);expect(await missing.json()).toEqual({error:'NOT_FOUND'});expect(writes()).toEqual([]);consumed();
 });
 if(method==='GET')it('loads the profile and ordered collections only for the resolved session owner',async()=>{
  sql(/SELECT id FROM konektag.users/,[{id:actor}],v=>expect(v).toEqual(['kc-owner']));sql(/SELECT \* FROM konektag.user_public_profiles/,[{user_id:actor,status:'draft'}],v=>expect(v).toEqual([actor]));
  for(const table of ['media','external_links','activities'])sql(new RegExp('FROM konektag.user_public_'+table),[{id:table}],(v,q)=>{expect(v).toEqual([actor]);expect(q).toContain('ORDER BY display_order');});
  expect(await(await call(source,method)).json()).toEqual({profile:{user_id:actor,status:'draft'},media:[{id:'media'}],externalLinks:[{id:'external_links'}],activities:[{id:'activities'}]});expect(writes()).toEqual([]);consumed();
 });
 else it('persists only allowed public fields, filters unsafe URLs and ignores a forged owner',async()=>{
  sql(/SELECT id FROM konektag.users/,[{id:actor}]);sql(/INSERT INTO konektag.user_public_profiles/,[],(v,q)=>{expect(v).toEqual([actor,'Ada',null,null,'public@example.invalid',null,null,'FR','Paris','published']);expect(q).toContain('version=user_public_profiles.version+1');});
  for(const table of ['media','external_links','activities'])sql(new RegExp('DELETE FROM konektag.user_public_'+table),[],v=>expect(v).toEqual([actor]));
  sql(/INSERT INTO konektag.user_public_media/,[],v=>expect(v).toEqual([actor,'https://media.invalid/photo','Portrait',0]));
  sql(/INSERT INTO konektag.user_public_external_links/,[],v=>expect(v).toEqual([actor,'Site','https://site.invalid',0]));
  sql(/INSERT INTO konektag.user_public_activities/,[],v=>expect(v).toEqual([actor,'Commerce',0]));
  const r=await call(source,method,{userId:'victim',firstName:'Ada',email:'public@example.invalid',country:'FR',city:'Paris',status:'published',media:[{url:'https://media.invalid/photo',alt:'Portrait'},{url:'javascript:alert(1)'}],externalLinks:[{url:'https://site.invalid',label:'Site'},{url:'file:///etc/passwd'}],activities:['Commerce']});expect(await r.json()).toEqual({success:true});expect(writes()).toHaveLength(7);consumed();
 });
});
describe('[REST BUSINESS GET /api/public/users]',()=>{
 it('does not enumerate profiles without a city',async()=>{expect(await(await call('public/users','GET')).json()).toEqual({profiles:[]});expect(db.query).not.toHaveBeenCalled();});
 it('returns only published city profiles ranked by public engagement, with bound country selection',async()=>{
  sql(/FROM konektag.user_public_profiles upp/,[{id,username:'ada',city_ambassador:true}],(v,q)=>{expect(v).toEqual(['Paris','FR']);expect(q).toContain("upp.status='published'");expect(q).toContain('LIMIT 10');expect(q).not.toMatch(/email_hash|encrypted_data|phone_hash/);});
  const r=await call('public/users','GET',undefined,{query:'?city=Paris&country=FR'});expect(await r.json()).toEqual({profiles:[{id,username:'ada',city_ambassador:true}]});expect(r.headers.get('cache-control')).toBe('public, max-age=60');expect(writes()).toEqual([]);consumed();
 });
 it('does not disclose database details when public discovery fails',async()=>{failure(/FROM konektag.user_public_profiles/,new Error('private SQL'));const r=await call('public/users','GET',undefined,{query:'?city=Paris'});expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'SERVER_ERROR'});consumed();});
});
describe('[REST BUSINESS GET /api/public/users/{id}]',()=>{
 it('returns only explicit public contact fields and ordered public collections',async()=>{
  sql(/WITH ranked AS/,[{username:'ada',public_first_name:'Ada',public_last_name:'Test',public_email:'public@example.invalid',public_phone:null,title:'Creator',description:'Public',country:'FR',city:'Paris',city_ambassador:true,city_rank:'2',encrypted_data:'NEVER_DISCLOSE'}],v=>expect(v).toEqual([id]));
  for(const table of ['media','external_links','activities'])sql(new RegExp('FROM konektag.user_public_'+table),[],v=>expect(v).toEqual([id]));
  sql(/FROM konektag.favorite_merchants/,[{name:'Shop',slug:'shop'}],v=>expect(v).toEqual([id]));sql(/FROM konektag.favorite_users f/,[{id:'friend',name:'Grace'}],v=>expect(v).toEqual([id]));
  const r=await call('public/users/[id]','GET',undefined,{signedIn:false});expect(await r.json()).toEqual({id,firstName:'Ada',lastName:'Test',displayName:'Ada Test',username:'ada',phone:null,email:'public@example.invalid',title:'Creator',description:'Public',country:'FR',city:'Paris',cityAmbassador:true,cityRank:2,media:[],externalLinks:[],activities:[],favorites:[{id:'friend',name:'Grace'},{name:'Shop',slug:'shop'}],isFavorite:false});expect(writes()).toEqual([]);consumed();
 });
 it('does not expose a draft, deleted or nonexistent public profile',async()=>{sql(/WITH ranked AS/);const r=await call('public/users/[id]','GET');expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'NOT_FOUND'});consumed();});
});
for(const method of ['GET','POST'])describe(`[REST BUSINESS ${method} /api/public/users/{id}/analytics]`,()=>{
 const source='public/users/[id]/analytics';
 if(method==='GET'){
  it('requires the exact profile owner before reading analytics',async()=>{expect((await call(source,method,undefined,{signedIn:false})).status).toBe(401);expect(db.query).not.toHaveBeenCalled();sql(/SELECT id FROM konektag.users/,[],v=>expect(v).toEqual([id,'kc-owner']));expect((await call(source,method)).status).toBe(403);consumed();});
  it('returns only the owner view/share aggregate',async()=>{sql(/SELECT id FROM konektag.users/,[{id}]);sql(/FROM konektag.user_public_profile_events/,[{views:12,shares:3}],v=>expect(v).toEqual([id]));expect(await(await call(source,method)).json()).toEqual({views:12,shares:3});expect(writes()).toEqual([]);consumed();});
 }else{
  it('rejects unsupported events before reading or writing analytics',async()=>{const r=await call(source,method,{event:'purchase'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_EVENT'});expect(db.query).not.toHaveBeenCalled();});
  it.each(['view','share'])('stores a %s event only for a published profile without storing raw visitor data',async event=>{
   sql(/SELECT 1 FROM konektag.user_public_profiles/,[{exists:1}],v=>expect(v).toEqual([id]));
   const visitor=createHash('sha256').update('|test-agent').digest('hex');if(event==='view')sql(/SELECT 1 FROM konektag.user_public_profile_events/,[],v=>expect(v).toEqual([id,visitor]));
   sql(/INSERT INTO konektag.user_public_profile_events/,[],v=>expect(v).toEqual([id,event,event==='view'?visitor:null]));
   const r=await call(source,method,{event},{headers:{'user-agent':'test-agent'},signedIn:false});expect(r.status).toBe(201);expect(await r.json()).toEqual({success:true});consumed();
  });
  it('deduplicates a recent view without incrementing persisted events again',async()=>{sql(/SELECT 1 FROM konektag.user_public_profiles/,[{exists:1}]);sql(/SELECT 1 FROM konektag.user_public_profile_events/,[{exists:1}],(_,q)=>expect(q).toContain("INTERVAL '30 minutes'"));expect(await(await call(source,method,{event:'view'})).json()).toEqual({success:true,deduplicated:true});expect(writes()).toEqual([]);consumed();});
  it('does not collect events for unpublished profiles',async()=>{sql(/SELECT 1 FROM konektag.user_public_profiles/);const r=await call(source,method,{event:'share'});expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'NOT_FOUND'});expect(writes()).toEqual([]);consumed();});
 }
});
for(const method of ['GET','POST'])describe(`[REST BUSINESS ${method} /api/users/search]`,()=>{
 const source='users/search';
 it('requires authentication before searching private hashed identity indexes',async()=>{const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'UNAUTHORIZED'});expect(db.query).not.toHaveBeenCalled();});
 it('binds username terms, normalizes and hashes email/phone, excludes the caller and returns safe fields',async()=>{
  const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
  sql(/SELECT u.id, u.username, u.country FROM konektag.users/,[{id,username:'ada',country:'FR'}],(v,q)=>{expect(v).toEqual(['kc-owner','%Ada%','%Test%',hash('ada@example.invalid'),hash('+330000')]);expect(q).toContain('u.deleted_at IS NULL');expect(q).toContain('u.id !=');expect(q).toContain('LIMIT 20');});
  expect(await(await call(source,method,{query:'Ada Test',email:' ADA@EXAMPLE.INVALID ',phone:' +330000 '},{query:'?q=Ada%20Test&email=%20ADA%40EXAMPLE.INVALID%20&phone=%20%2B330000%20'})).json()).toEqual([{id,username:'ada',country:'FR'}]);expect(writes()).toEqual([]);consumed();
 });
 it('preserves an empty search without enumerating the users table',async()=>{expect(await(await call(source,method,{})).json()).toEqual([]);expect(db.query).not.toHaveBeenCalled();});
});
