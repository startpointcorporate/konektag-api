import { beforeEach,describe,expect,it,vi } from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,actor} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db,query:db.query,getClient:db.connect}));
beforeEach(reset);
const category={id,code:'food',name_i18n:{fr:'Cuisine'},description:'Cuisine',icon:'food',sort_order:2,is_active:true};
for(const [source,method,path] of [
 ['admin/categories/index','GET','/api/admin/categories'],['admin/categories/index','POST','/api/admin/categories'],
 ['admin/categories/[id]','GET','/api/admin/categories/{id}'],['admin/categories/[id]','PUT','/api/admin/categories/{id}'],['admin/categories/[id]','DELETE','/api/admin/categories/{id}'],
])describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('requires an actual database admin role before accessing categories',async()=>{
  expect(await(await call(source,method,{}, {signedIn:false})).json()).toEqual({error:'Unauthorized'});expect(db.query).not.toHaveBeenCalled();db.role='operations';
  expect((await call(source,method,{})).status).toBe(401);expect(writes()).toEqual([]);
 });
 if(method==='GET') {
  it('returns the category/capability projection while preserving the selected id',async()=>{
   sql(/FROM konektag.merchant_categories mc/,[{...category,capabilities:['CATALOG','BOOKING']}],(v,q)=>{expect(q).toContain('merchant_category_capabilities');expect(v).toEqual(source.endsWith('/[id]')?[id]:[]);});
   expect(await(await call(source,method)).json()).toEqual(source.endsWith('/[id]')?{...category,capabilities:['CATALOG','BOOKING']}:[{...category,capabilities:['CATALOG','BOOKING']}]);expect(writes()).toEqual([]);consumed();
  });
  it('does not expose SQL details on database failure',async()=>{failure(/FROM konektag.merchant_categories/,new Error('private-secret'));const r=await call(source,method);expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'SERVER_ERROR'});consumed();});
 }else if(method==='DELETE') {
  it('soft-disables the existing category and retains its historical identity',async()=>{
   sql(/SELECT id FROM konektag.merchant_categories/,[{id}],v=>expect(v).toEqual([id]));sql(/UPDATE konektag.merchant_categories/,[],(v,q)=>{expect(v).toEqual([id]);expect(q).toContain('is_active = false');});
   expect(await(await call(source,method)).json()).toEqual({success:true});expect(writes()).toHaveLength(1);consumed();
  });
  it('rejects an unknown category without changing data',async()=>{sql(/SELECT id FROM konektag.merchant_categories/);expect(await(await call(source,method)).json()).toEqual({error:'Category not found'});expect(writes()).toEqual([]);consumed();});
 }else {
  it('validates required fields and JSON before writing',async()=>{const r=await call(source,method,{code:'food',name_i18n:'not-an-object'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'Invalid input data'});const malformed=await call(source,method,{}, {raw:'{'});expect(await malformed.json()).toEqual({error:'Invalid JSON'});expect(writes()).toEqual([]);});
  it('persists category fields and only recognized capabilities',async()=>{
   if(method==='PUT')sql(/SELECT id FROM konektag.merchant_categories WHERE id/,[{id}]);sql(/SELECT id FROM konektag.merchant_categories WHERE code/);
   sql(new RegExp(`${method==='POST'?'INSERT INTO':'UPDATE'} konektag.merchant_categories`),[{id}],v=>expect(v).toEqual(['food',JSON.stringify(category.name_i18n),'Cuisine','food',2,true,...(method==='PUT'?[id]:[])]));
   if(method==='PUT')sql(/DELETE FROM konektag.merchant_category_capabilities/,[],v=>expect(v).toEqual([id]));
   for(const capability of ['catalog','booking'])sql(/INSERT INTO konektag.merchant_category_capabilities/,[],v=>expect(v).toEqual([id,capability]));
   const r=await call(source,method,{...category,capabilities:['CATALOG','BOOKING','INVALID']});expect(r.status).toBe(method==='POST'?201:200);expect(await r.json()).toEqual(method==='POST'?{id}:{success:true});consumed();
  });
  it('rejects duplicate codes without a category or capability write',async()=>{
   if(method==='PUT')sql(/SELECT id FROM konektag.merchant_categories WHERE id/,[{id}]);sql(/SELECT id FROM konektag.merchant_categories WHERE code/,[{id:'duplicate'}]);
   const r=await call(source,method,category);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'Code already exists'});expect(writes()).toEqual([]);consumed();
  });
 }
});
for(const [source,method,path] of [
 ['admin/disputes/index','GET','/api/admin/disputes'],['admin/disputes/index','POST','/api/admin/disputes'],
 ['admin/disputes/[id]','GET','/api/admin/disputes/{id}'],['admin/disputes/[id]','PUT','/api/admin/disputes/{id}'],
])describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('requires identity and, for back-office reads/resolution, the real compliance permission',async()=>{
  const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(method==='POST'?401:403);expect(await r.json()).toMatchObject({error:method==='POST'?'UNAUTHORIZED':'FORBIDDEN'});expect(db.query).not.toHaveBeenCalled();
  if(method!=='POST'){db.role='support';const denied=await call(source,method,{});expect(denied.status).toBe(403);expect(await denied.json()).toMatchObject({error:'FORBIDDEN'});expect(writes()).toEqual([]);}
 });
 if(method==='GET') {
  it('returns scoped disputes from the database with bound filter/id',async()=>{
   const dispute={id,status:'OPEN',username:'ada'};sql(/FROM konektag.disputes d/,[dispute],v=>expect(v).toEqual(source.endsWith('/[id]')?[id]:['OPEN',3]));
   expect(await(await call(source,method,undefined,{query:'?status=OPEN&limit=3'})).json()).toEqual(source.endsWith('/[id]')?dispute:{disputes:[dispute]});expect(writes()).toEqual([]);consumed();
  });
  if(source.endsWith('/[id]'))it('returns NOT_FOUND for a deleted or missing dispute',async()=>{sql(/FROM konektag.disputes d/);const r=await call(source,method);expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'NOT_FOUND'});consumed();});
 }else if(method==='POST') {
  it.each([['litige_commercial',14],['incident_psp',7],['chargeback',30],['remboursement_legal',30]])('assigns the authenticated claimant and %s SLA',async(disputeType,days)=>{
   sql(/INSERT INTO konektag.disputes/,[{id,status:'OPEN',dispute_type:disputeType}],v=>{expect(v[0]).toMatch(/^DISPUTE-/);expect(v.slice(1)).toEqual([actor,'operation-1',disputeType,'Missing goods',days]);});
   const r=await call(source,method,{operationId:'operation-1',disputeType,description:'Missing goods',userId:'victim'});expect(r.status).toBe(201);expect(await r.json()).toEqual({id,status:'OPEN',dispute_type:disputeType});consumed();
  });
  it('rejects malformed JSON without creating a dispute',async()=>{const r=await call(source,method,{}, {raw:'{'});expect(r.status).toBe(400);expect(await r.json()).toHaveProperty('error');expect(writes()).toEqual([]);});
 }else {
  it('persists resolution with the authenticated reviewer rather than caller-supplied actor',async()=>{
   sql(/UPDATE konektag.disputes/,[{id,status:'RESOLVED',resolution:'Refunded'}],(v,q)=>{expect(v).toEqual(['RESOLVED','Refunded',actor,id]);expect(q).toContain('deleted_at IS NULL');expect(q).toContain('resolved_at = now()');});
   expect(await(await call(source,method,{status:'RESOLVED',resolution:'Refunded',resolvedBy:'victim'})).json()).toEqual({id,status:'RESOLVED',resolution:'Refunded'});consumed();
  });
  it('does not claim resolution when the dispute does not exist',async()=>{sql(/UPDATE konektag.disputes/);const r=await call(source,method,{});expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'NOT_FOUND'});consumed();});
 }
});
for(const method of ['GET','POST'])describe(`[REST BUSINESS ${method} /api/admin/users]`,()=>{
 const source='admin/users/index';
 it('uses the database role and refuses an unprivileged session without a user mutation',async()=>{db.role='user';const r=await call(source,method,{});expect(r.status).toBe(403);expect(await r.json()).toEqual({error:'FORBIDDEN'});expect(writes()).toEqual([]);});
 if(method==='GET') {
  it('binds search and excludes banned/deleted users from eligible owner selection',async()=>{
   sql(/FROM konektag.users u/,[{id,username:'ada'}],(v,q)=>{expect(v).toEqual(['%ada%']);expect(q).toContain('u.banned_at IS NULL');expect(q).toContain('u.deleted_at IS NULL');expect(q).toContain('LIMIT 20');});
   expect(await(await call(source,method,undefined,{query:'?q=ada&eligibleMerchantOwner=1&banned=1&autocomplete=1'})).json()).toEqual([{id,username:'ada'}]);expect(writes()).toEqual([]);consumed();
  });
  it('does not enumerate users for a one-character autocomplete',async()=>{expect(await(await call(source,method,undefined,{query:'?q=a&autocomplete=1'})).json()).toEqual([]);expect(db.query).toHaveBeenCalledOnce();});
 }else {
  it.each(['ban','unban'])('persists %s and emits an audit event for the actual admin',async action=>{
   sql(/UPDATE konektag.users/,[],(v,q)=>{expect(v).toEqual([id]);expect(q).toContain(action==='ban'?'banned_at = now()':'banned_at = NULL');});
   sql(/INSERT INTO konektag.audit_logs/,[],v=>{expect(v[0]).toBe(actor);expect(v[2]).toBe(`ADMIN_USER_${action.toUpperCase()}`);expect(v[3]).toEqual({targetUserId:id});});
   expect(await(await call(source,method,{userId:id,action,actor:'victim'})).json()).toEqual({success:true});consumed();
  });
  it('rejects unsupported actions before changing users or audit logs',async()=>{const r=await call(source,method,{userId:id,action:'delete'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_REQUEST'});expect(writes()).toEqual([]);});
 }
});
