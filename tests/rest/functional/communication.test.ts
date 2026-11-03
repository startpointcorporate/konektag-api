import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,consumed,writes,call,id} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(()=>{reset();vi.stubEnv('COMMUNICATION_UNSUBSCRIBE_SECRET','isolated-secret');});
function update(user:string,source:string,ip:string|null){
 sql(/SELECT \* FROM konektag.users WHERE id/,[{id:user}],v=>expect(v).toEqual([user]));sql(/SELECT \* FROM konektag.communication_consents/,[{status:'granted'}],v=>expect(v).toEqual([user,'email']));
 sql(/INSERT INTO konektag.communication_consents/,[{id:'consent'}],(v,q)=>{expect(v).toEqual([user,'email','denied',source,ip]);expect(q).toContain('version = communication_consents.version + 1');});
 sql(/INSERT INTO konektag.audit_logs/,[],v=>{expect(v[0]).toBe(user);expect(v[2]).toBe('communication.consent.updated');expect(JSON.parse(v[3])).toEqual({channel:'email',previousStatus:'granted',newStatus:'denied',source});});
 sql(/INSERT INTO konektag.outbox_events/,[],v=>{expect(v.slice(1,5)).toEqual(['User',user,'CommunicationPreferencesUpdated',1]);expect(JSON.parse(v[5])).toMatchObject({userId:user,changes:[{channel:'email',previousStatus:'granted',newStatus:'denied',source}]});});
}
for(const method of ['GET','PUT'])describe(`[REST BUSINESS ${method} /api/communication/preferences]`,()=>{
 const source='communication/preferences';
 it('requires authentication before reading or modifying communication choices',async()=>{const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'Unauthorized'});expect(db.query).not.toHaveBeenCalled();});
 if(method==='GET'){
  it('runs the real default-consent policy while preserving explicit denied channels',async()=>{sql(/SELECT \* FROM konektag.communication_consents/,[{channel:'email',status:'denied'},{channel:'push',status:'granted'}],v=>expect(v).toEqual(['kc-owner']));expect(await(await call(source,method)).json()).toEqual({preferences:{email:'denied',sms:'granted',push:'granted',whatsapp:'granted'}});expect(writes()).toEqual([]);expect(db.release).toHaveBeenCalledOnce();consumed();});
  it.fails('looks up internal user consent by the canonical user id, not a different Keycloak id (known identity defect)',async()=>{sql(/SELECT \* FROM konektag.communication_consents/);await call(source,method);expect(db.query.mock.calls.find(([q])=>q.includes('communication_consents'))?.[1]).toEqual(['11111111-1111-4111-8111-111111111111']);});
 }else{
  it('validates all requested channels and statuses before any consent write',async()=>{const r=await call(source,method,{preferences:[{channel:'fax',status:'granted'}]});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'Invalid channel or status: fax/granted'});expect(db.query).not.toHaveBeenCalled();});
  it('executes the real consent repository, audit and outbox inside a repeatable-read transaction',async()=>{update('kc-owner','settings','127.0.0.1');expect(await(await call(source,method,{preferences:[{channel:'email',status:'denied'}],userId:'victim'},{headers:{'x-forwarded-for':'127.0.0.1, 10.0.0.1'}})).json()).toEqual({success:true});expect(db.query.mock.calls.some(([q])=>q==='BEGIN ISOLATION LEVEL REPEATABLE READ')).toBe(true);expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();});
  it.fails('resolves the canonical internal user before changing consent (known identity defect)',async()=>{sql(/SELECT \* FROM konektag.users WHERE id/);await call(source,method,{preferences:[{channel:'email',status:'denied'}]});expect(db.query.mock.calls.find(([q])=>q.includes('SELECT * FROM konektag.users'))?.[1]).toEqual(['11111111-1111-4111-8111-111111111111']);});
 }
});
describe('[REST BUSINESS GET /api/communication/unsubscribe/{channel}]',()=>{
 const source='communication/unsubscribe/[channel]';
 it('validates channel, token presence and configured secret before a consent mutation',async()=>{
  expect(await(await call(source,'GET',undefined,{params:{channel:'fax'}})).json()).toEqual({error:'Invalid channel'});
  expect(await(await call(source,'GET',undefined,{params:{channel:'email'}})).json()).toEqual({error:'Missing userId or token'});
  const bad=await call(source,'GET',undefined,{params:{channel:'email'},query:`?userId=${id}&token=wrong`});expect(bad.status).toBe(403);expect(await bad.json()).toEqual({error:'Invalid token'});expect(db.query).not.toHaveBeenCalled();
 });
 it('accepts only the exact user/channel capability and persists denial with link provenance',async()=>{
  const token=createHash('sha256').update(`${id}:email:isolated-secret`).digest('hex');update(id,'unsubscribe_link',null);
  const r=await call(source,'GET',undefined,{signedIn:false,params:{channel:'email'},query:`?userId=${id}&token=${token}`});expect(r.status).toBe(200);expect(r.headers.get('content-type')).toContain('text/html');expect(await r.text()).toContain('Désabonnement confirmé');expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();
 });
});
