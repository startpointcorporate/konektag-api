import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,actor,pgError} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(reset);
const body={internalName:' spring ',publicTitle:' Spring ',startsAt:'2026-03-01T00:00:00Z',endsAt:'2026-04-01T00:00:00Z',maxBonusAmount:100,eligibleCountryCodes:[' fr ','FR','bj'],milestones:[{metricType:'Deposit',targetAmount:1000,bonusAmount:50,publicTitle:' Deposit ',ctaType:' recharge ',eligibleCountryCodes:['fr']} ]};
for(const [source,method,path] of [
 ['admin/activation-campaigns/index','GET','/api/admin/activation-campaigns'],['admin/activation-campaigns/index','POST','/api/admin/activation-campaigns'],
 ['admin/activation-campaigns/[id]','GET','/api/admin/activation-campaigns/{id}'],['admin/activation-campaigns/[id]','PATCH','/api/admin/activation-campaigns/{id}'],
 ['admin/activation-campaigns/[id]/statistics','GET','/api/admin/activation-campaigns/{id}/statistics'],['admin/activation-campaigns/[id]/[action]','POST','/api/admin/activation-campaigns/{id}/{action}'],
])describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('requires a live database admin role before changing or reporting campaigns',async()=>{const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(403);expect(await r.json()).toEqual({error:'FORBIDDEN'});expect(db.query).not.toHaveBeenCalled();db.role='support';expect((await call(source,method,{})).status).toBe(403);expect(writes()).toEqual([]);});
 if(method==='GET'){
  it('returns the actual campaign projection with its bounded campaign scope',async()=>{
   if(source.endsWith('statistics')){sql(/SELECT COUNT\(ch.id\)/,[{participants:2,bonuses_credited:'100'}],v=>expect(v).toEqual([id]));sql(/SELECT m.id,m.public_title|SELECT m.id, m.public_title/,[{id:'milestone',reached_count:1}],v=>expect(v).toEqual([id]));sql(/SELECT COALESCE\(a.country_code/,[{country_code:'FR',activity_count:2}],v=>expect(v).toEqual([id]));expect(await(await call(source,method)).json()).toEqual({summary:{participants:2,bonuses_credited:'100'},milestones:[{id:'milestone',reached_count:1}],countries:[{country_code:'FR',activity_count:2}]});}
   else{sql(/FROM konektag.activation_campaigns c/,[{id,public_title:'Spring',milestones:[]}],(v,q)=>{expect(v).toEqual(source.endsWith('[id]')?[id]:[]);expect(q).toContain('c.deleted_at IS NULL');});expect(await(await call(source,method)).json()).toEqual(source.endsWith('[id]')?{campaign:{id,public_title:'Spring',milestones:[]}}:{campaigns:[{id,public_title:'Spring',milestones:[]}]});}
   expect(writes()).toEqual([]);consumed();
  });
  if(source.endsWith('[id]'))it('does not fabricate a missing campaign',async()=>{sql(/FROM konektag.activation_campaigns c/);const r=await call(source,method);expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'NOT_FOUND'});consumed();});
 }else if(method==='PATCH'){
  it('updates only editable campaign fields with the authenticated actor and optimistic version',async()=>{sql(/UPDATE konektag.activation_campaigns/,[{id,version:3}],(v,q)=>{expect(v).toEqual(['Updated',null,null,actor,id,2]);expect(q).toContain("status IN ('draft', 'paused')");expect(q).toContain('version = $6');});expect(await(await call(source,method,{publicTitle:'Updated',version:2,updatedBy:'victim'})).json()).toEqual({campaign:{id,version:3}});consumed();});
  it('rejects a stale or locked campaign rather than overwriting it',async()=>{sql(/UPDATE konektag.activation_campaigns/);const r=await call(source,method,{publicTitle:'Updated',version:2});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'VERSION_CONFLICT_OR_LOCKED'});consumed();});
  it.each([{version:1.5},{version:2,status:'active'}])('refuses an invalid update %j before writing',async input=>{const r=await call(source,method,input);expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_UPDATE'});expect(writes()).toEqual([]);});
 }else if(source.endsWith('[action]')){
  it.each([['activate',['draft','paused'],'active'],['resume',['paused'],'active'],['pause',['active'],'paused'],['complete',['active','paused'],'completed'],['archive',['draft','completed','paused'],'archived']] as const)('performs %s only from eligible states and commits both audits',async(action,allowed,target)=>{
   sql(/UPDATE konektag.activation_campaigns/,[{id,status:target,version:3}],v=>expect(v).toEqual([target,actor,id,[...allowed],2]));
   sql(/INSERT INTO konektag.admin_actions/,[],v=>{expect(v.slice(0,4)).toEqual([actor,`ACTIVATION_CAMPAIGN_${action.toUpperCase()}`,id,'reviewed']);expect(JSON.parse(v[4])).toEqual({action,previousStatuses:[...allowed],newStatus:target});});
   sql(/INSERT INTO konektag.activation_campaign_audit/,[],v=>expect(v.slice(0,3)).toEqual([id,actor,action]));
   expect(await(await call(source,method,{version:2,reason:'reviewed',actor:'victim'},{params:{id,action}})).json()).toEqual({campaign:{id,status:target,version:3}});expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();
  });
  it('rolls back an ineligible transition without emitting misleading audit events',async()=>{sql(/UPDATE konektag.activation_campaigns/);const r=await call(source,method,{version:2},{params:{id,action:'pause'}});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'INVALID_TRANSITION_OR_VERSION_CONFLICT'});expect(db.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(true);expect(writes()).toHaveLength(1);expect(db.release).toHaveBeenCalledOnce();consumed();});
  it('refuses activation when another campaign is active and rolls back the transaction',async()=>{failure(/UPDATE konektag.activation_campaigns/,pgError('23505'));const r=await call(source,method,{}, {params:{id,action:'activate'}});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'ANOTHER_CAMPAIGN_IS_ACTIVE'});expect(db.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(true);consumed();});
  it('rejects unknown campaign actions before opening a transaction',async()=>{const r=await call(source,method,{}, {params:{id,action:'delete'}});expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'UNKNOWN_ACTION'});expect(db.connect).not.toHaveBeenCalled();});
 }else{
  it.each([{endsAt:body.startsAt},{maxBonusAmount:-1},{eligibleCountryCodes:['invalid']},{milestones:[]}])('rejects invalid campaign data %j before opening a transaction',async input=>{const r=await call(source,method,{...body,...input});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_CAMPAIGN'});expect(db.connect).not.toHaveBeenCalled();});
  it('rejects bonuses exceeding the campaign cap and invalid milestone metrics',async()=>{expect(await(await call(source,method,{...body,maxBonusAmount:40})).json()).toEqual({error:'INVALID_BONUS_TOTAL'});expect(await(await call(source,method,{...body,milestones:[{...body.milestones[0],metricType:'Unknown'}]})).json()).toEqual({error:'INVALID_MILESTONE',index:0});expect(writes()).toEqual([]);});
  it('creates campaign, normalized countries and milestones atomically with admin audit evidence',async()=>{
   sql(/INSERT INTO konektag.activation_campaigns/,[{id}],v=>{expect(v.slice(0,2)).toEqual(['spring','Spring']);expect(v.slice(6)).toEqual([90,100,['FR','BJ'],actor]);expect(v[4]).toEqual(new Date(body.startsAt));expect(v[5]).toEqual(new Date(body.endsAt));});
   sql(/INSERT INTO konektag.activation_milestones/,[],v=>expect(v).toEqual([id,'Deposit',1000,50,false,1,'Deposit','','recharge',['FR']]));
   sql(/INSERT INTO konektag.admin_actions/,[],v=>expect(v.slice(0,2)).toEqual([actor,id]));sql(/INSERT INTO konektag.activation_campaign_audit/,[],v=>expect(v.slice(0,2)).toEqual([id,actor]));
   const r=await call(source,method,body);expect(r.status).toBe(201);expect(await r.json()).toEqual({id});expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();
  });
  it('rolls back duplicate campaigns and returns a business conflict',async()=>{failure(/INSERT INTO konektag.activation_campaigns/,pgError('23505'));const r=await call(source,method,body);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'CAMPAIGN_ALREADY_EXISTS'});expect(db.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(true);expect(db.release).toHaveBeenCalledOnce();consumed();});
 }
});
describe('[REST BUSINESS GET /api/activation-campaign/current]',()=>{
 it('returns the public active campaign with enabled ordered milestones without administrative fields',async()=>{sql(/FROM konektag.activation_campaigns c/,[{id,public_title:'Spring',milestones:[{metricType:'Deposit',bonusAmount:50}]}],(v,q)=>{expect(v).toEqual([]);expect(q).toContain("c.status = 'active'");expect(q).toContain('c.starts_at <= now()');expect(q).toContain('m.is_enabled');expect(q).not.toContain('c.internal_name');});expect(await(await call('activation-campaign/current','GET')).json()).toEqual({campaign:{id,public_title:'Spring',milestones:[{metricType:'Deposit',bonusAmount:50}]}});expect(writes()).toEqual([]);consumed();});
 it('returns null when no campaign is currently active',async()=>{sql(/FROM konektag.activation_campaigns c/);expect(await(await call('activation-campaign/current','GET')).json()).toEqual({campaign:null});consumed();});
});
