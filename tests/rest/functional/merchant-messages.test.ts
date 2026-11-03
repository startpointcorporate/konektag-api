import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,actor} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(reset);
for(const method of ['GET','PUT'])describe(`[REST BUSINESS ${method} /api/merchant/messages]`,()=>{
 it('refuses anonymous message access without a database query',async()=>{const r=await call('merchant/messages',method,{}, {signedIn:false});expect(r.status).toBe(401);if(method==='GET')expect(await r.json()).toEqual({messages:[],total:0,unreadCount:0});expect(db.query).not.toHaveBeenCalled();});
 if(method==='GET'){
  it('reads only the authenticated merchant messages and returns numeric unread totals',async()=>{sql(/SELECT COUNT\(\*\) as total/,[{total:'3',unread_count:'2'}],v=>expect(v).toEqual([actor]));sql(/SELECT cm.\*, mp.business_name/,[{id,message:'Hello'}],(v,q)=>{expect(v).toEqual([actor,5,2]);expect(q).toContain('mp.user_id = $1');expect(q).toContain('cm.deleted_at IS NULL');});expect(await(await call('merchant/messages',method,undefined,{query:'?limit=5&offset=2'})).json()).toEqual({messages:[{id,message:'Hello'}],total:3,unreadCount:2});expect(writes()).toEqual([]);consumed();});
  it('preserves the historical empty fallback on unavailable storage',async()=>{failure(/SELECT COUNT\(\*\)/,new Error('private'));expect(await(await call('merchant/messages',method)).json()).toEqual({messages:[],total:0,unreadCount:0});consumed();});
 }else{
  it('requires an explicit message id before marking messages read',async()=>{const r=await call('merchant/messages',method,{});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'BAD_REQUEST'});expect(db.query).not.toHaveBeenCalled();});
  it('persists read state and increments the selected message version',async()=>{sql(/UPDATE konektag.contact_messages/,[],(v,q)=>{expect(v).toEqual([id]);expect(q).toContain('is_read = TRUE');expect(q).toContain('version = version + 1');});expect(await(await call('merchant/messages',method,{}, {query:`?id=${id}`})).json()).toEqual({success:true});consumed();});
  it.fails('rejects a foreign merchant message instead of mutating it by id alone (known ownership defect)',async()=>{sql(/UPDATE konektag.contact_messages/,[],undefined,1);const r=await call('merchant/messages',method,{}, {query:'?id=foreign-message'});expect(r.status).toBe(403);expect(writes()).toEqual([]);});
 }
});
describe('[REST BUSINESS POST /api/merchant/contact]',()=>{
 const input={slug:'shop',senderName:'Ada',senderEmail:'ada@example.invalid',message:'x'.repeat(150)};
 it('requires contact fields before creating a message or outbox event',async()=>{const r=await call('merchant/contact','POST',{slug:'shop'});expect(r.status).toBe(400);expect(await r.json()).toMatchObject({error:'BAD_REQUEST'});expect(db.query).not.toHaveBeenCalled();});
 it.each([true,false])('persists contact and notification atomically and excludes owner self-interactions=%s from analytics',async self=>{
  sql(/SELECT id, user_id, business_name FROM konektag.merchant_profiles/,[{id,user_id:actor,business_name:'Shop'}],v=>expect(v).toEqual(['shop']));
  sql(/INSERT INTO konektag.contact_messages/,[{id:'message-1'}],v=>expect(v).toEqual([id,'Ada','ada@example.invalid',null,input.message]));
  sql(/INSERT INTO konektag.outbox_events/,[],v=>{expect(v[1]).toBe(id);expect(JSON.parse(v[2])).toEqual({messageId:'message-1',profileId:id,senderName:'Ada',senderEmail:'ada@example.invalid',messagePreview:'x'.repeat(100),businessName:'Shop',userId:actor});});
  if(!self)sql(/INSERT INTO konektag.profile_analytics/,[],v=>expect(v).toEqual([id,JSON.stringify({messageId:'message-1'})]));
  const r=await call('merchant/contact','POST',{...input,actorId:'victim'},{signedIn:self});expect(r.status).toBe(201);expect(await r.json()).toEqual({success:true,messageId:'message-1'});expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();
 });
 it('rolls back a failed message insertion without emitting delivery or analytics events',async()=>{sql(/SELECT id, user_id, business_name/,[{id,user_id:actor,business_name:'Shop'}]);failure(/INSERT INTO konektag.contact_messages/,new Error('CONTACT_STORAGE_UNAVAILABLE'));const r=await call('merchant/contact','POST',input);expect(r.status).toBe(422);expect(await r.json()).toEqual({error:'CONTACT_ERROR',message:'CONTACT_STORAGE_UNAVAILABLE'});expect(writes()).toHaveLength(1);expect(db.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(true);expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(false);expect(db.release).toHaveBeenCalledOnce();consumed();});
});
