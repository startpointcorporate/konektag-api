import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,actor} from './database';
const external=vi.hoisted(()=>({list:vi.fn(),chat:vi.fn(),health:vi.fn(),publishKycStatus:vi.fn()}));
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
vi.mock('../../../src/infrastructure/adapters/erpnext-adapter.ts',()=>({erpnext:external}));
vi.mock('../../../src/infrastructure/adapters/dify-adapter.ts',()=>({difyAdapter:external}));
vi.mock('../../../src/infrastructure/adapters/redis-adapter.ts',()=>({redisAdapter:external}));
beforeEach(()=>{reset();vi.stubEnv('INTERNAL_API_TOKEN','isolated-internal-token');});
afterEach(()=>vi.restoreAllMocks());
for(const method of ['GET','POST'])describe(`[REST BUSINESS ${method} /api/auth/country-confirmation]`,()=>{
 const source='auth/country-confirmation';
 it('requires a live session user before reading or modifying confirmed country',async()=>{const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'UNAUTHORIZED'});expect(db.query).not.toHaveBeenCalled();});
 if(method==='GET'){
  it.each([null,'2026-09-30T12:00:00.000Z','2026-10-01T12:00:00.000Z','2026-10-31T12:00:00.000Z'])('applies the thirty-day confirmation rule to %s',async confirmed=>{
   vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-31T12:00:00.000Z'));sql(/SELECT id,country,country_confirmed_at/,[{id:actor,country:'FR',country_confirmed_at:confirmed}],v=>expect(v).toEqual(['kc-owner']));
   expect(await(await call(source,method)).json()).toEqual({country:'FR',countryConfirmedAt:confirmed,due:confirmed===null||confirmed<='2026-10-01T12:00:00.000Z'});expect(writes()).toEqual([]);consumed();
  });
 }else{
  it('normalizes and persists only a currently approved country with its canonical currency',async()=>{
   sql(/SELECT id,country,country_confirmed_at/,[{id:actor}]);sql(/SELECT country_code,base_currency/,[{country_code:'FR',base_currency:'EUR'}],(v,q)=>{expect(v).toEqual(['FR']);expect(q).toContain("status='APPROVED'");expect(q).toContain('valid_until>=CURRENT_DATE');});
   sql(/UPDATE konektag.users/,[{country:'FR',country_confirmed_at:'2026-11-03T00:00:00Z'}],v=>expect(v).toEqual(['FR',actor]));
   expect(await(await call(source,method,{country:' fr ',userId:'victim'})).json()).toEqual({country:'FR',countryConfirmedAt:'2026-11-03T00:00:00Z',currency:'EUR',due:false});consumed();
  });
  it.each(['invalid','ZZ'])('rejects invalid or unsupported country %s without changing the profile',async country=>{sql(/SELECT id,country,country_confirmed_at/,[{id:actor}]);if(country==='ZZ')sql(/SELECT country_code,base_currency/);const r=await call(source,method,{country});expect(r.status).toBe(country==='ZZ'?409:400);expect(await r.json()).toEqual({error:country==='ZZ'?'COUNTRY_NOT_SUPPORTED':'INVALID_COUNTRY'});expect(writes()).toEqual([]);consumed();});
 }
});
describe('[REST BUSINESS GET /api/pay/countries]',()=>{
 it('uses the ERP Country catalogue, discards malformed entries and returns sorted ISO codes',async()=>{external.list.mockResolvedValue([{name:'France',code:'fr'},{name:'Bénin',code:'bj'},{name:'Unknown',code:'XXX'},{name:4,code:'UK'}]);expect(await(await call('pay/countries','GET')).json()).toEqual({countries:[{code:'BJ',name:'Bénin'},{code:'FR',name:'France'}]});expect(external.list).toHaveBeenCalledWith('Country',undefined,['name','code'],500);expect(writes()).toEqual([]);});
 it('reports unavailable catalogue instead of inventing supported payment countries',async()=>{external.list.mockRejectedValue(new Error('private ERP detail'));const r=await call('pay/countries','GET');expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'COUNTRIES_UNAVAILABLE'});});
});
describe('[REST BUSINESS POST /api/chat]',()=>{
 it('requires a query before contacting the conversation provider',async()=>{const r=await call('chat/index','POST',{});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'Query required'});expect(external.chat).not.toHaveBeenCalled();});
 it.each(['general','merchant'])('preserves %s conversation context and provider response',async profile=>{external.chat.mockResolvedValue({answer:'Response',conversation_id:'conversation-1'});expect(await(await call('chat/index','POST',{query:'Help',profile,conversation_id:'conversation-1'})).json()).toEqual({answer:'Response',conversation_id:'conversation-1'});expect(external.chat).toHaveBeenCalledWith({query:'Help',user:profile,inputs:profile==='general'?{}:{profile},response_mode:'blocking',conversation_id:'conversation-1'});});
 it('reports provider failure as a gateway failure without a fabricated answer',async()=>{external.chat.mockRejectedValue(new Error('CHAT_UNAVAILABLE'));const r=await call('chat/index','POST',{query:'Help'});expect(r.status).toBe(502);expect(await r.json()).toEqual({error:'CHAT_UNAVAILABLE'});});
});
describe('[REST BUSINESS GET /api/internal/dify-health]',()=>{
 it('returns only public health and version fields',async()=>{external.health.mockResolvedValue({status:'ok',version:'1.0',token:'NEVER_DISCLOSE'});const before=Date.now();const r=await call('internal/dify-health','GET');expect(r.status).toBe(200);const b=await r.json();expect(b).toEqual({status:'healthy',dify:{status:'ok',version:'1.0'},timestamp:expect.any(String)});expect(Date.parse(b.timestamp)).toBeGreaterThanOrEqual(before);});
 it('distinguishes unreachable dependencies from healthy state',async()=>{external.health.mockRejectedValue(new Error('private configuration'));const r=await call('internal/dify-health','GET');expect(r.status).toBe(503);expect(await r.json()).toEqual({status:'degraded',dify:{status:'unreachable'},timestamp:expect.any(String)});});
});
describe('[REST BUSINESS POST /api/internal/kyc-publish-status]',()=>{
 it('refuses an incorrect bearer token before publishing events',async()=>{expect((await call('internal/kyc-publish-status','POST',{user_id:id,status:'KYC_VERIFIED'})).status).toBe(401);expect(external.publishKycStatus).not.toHaveBeenCalled();});
 it('publishes exactly the supplied user status with server timestamp after internal authentication',async()=>{const r=await call('internal/kyc-publish-status','POST',{user_id:id,status:'KYC_VERIFIED',details:{step:'complete'}},{headers:{Authorization:'Bearer isolated-internal-token'}});expect(r.status).toBe(204);expect(await r.text()).toBe('');expect(external.publishKycStatus).toHaveBeenCalledWith(id,{status:'KYC_VERIFIED',step:'complete',timestamp:expect.any(String)});});
 it('reports malformed authenticated events without publishing',async()=>{const r=await call('internal/kyc-publish-status','POST',{}, {raw:'{',headers:{Authorization:'Bearer isolated-internal-token'}});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'Invalid payload'});expect(external.publishKycStatus).not.toHaveBeenCalled();});
 it.fails('fails closed when no internal token is configured (known authentication defect)',async()=>{vi.stubEnv('INTERNAL_API_TOKEN',undefined);const r=await call('internal/kyc-publish-status','POST',{user_id:id,status:'KYC_VERIFIED'});expect(r.status).toBe(401);expect(external.publishKycStatus).not.toHaveBeenCalled();});
});
describe('[REST BUSINESS GET /api/merchant/cards/sales-today]',()=>{
 it('refuses anonymous sales data access without querying cards',async()=>{const r=await call('merchant/cards/sales-today','GET',undefined,{signedIn:false});expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'UNAUTHORIZED'});expect(db.query).not.toHaveBeenCalled();});
 it('scopes sold-card daily totals to the authenticated seller and live cards',async()=>{sql(/FROM konektag.cards/,[{count:2,total_amount:10000}],(v,q)=>{expect(v).toEqual([actor]);expect(q).toContain("status = 'SOLD'");expect(q).toContain('sold_at::date = CURRENT_DATE');expect(q).toContain('deleted_at IS NULL');});expect(await(await call('merchant/cards/sales-today','GET')).json()).toEqual({count:2,total_amount:10000});expect(writes()).toEqual([]);consumed();});
});
describe('[REST BUSINESS GET /api/merchant/certification-status]',()=>{
 it('does not enumerate merchants without a slug',async()=>{expect(await(await call('merchant/certification-status','GET')).json()).toEqual({certified:false});expect(db.query).not.toHaveBeenCalled();});
 it.each(['VALIDATED','PENDING','REJECTED'])('derives certified state from %s rather than a caller flag',async status=>{sql(/FROM konektag.merchant_profiles/,[{certification_status:status,certification_submitted_at:'2026-01-01'}],v=>expect(v).toEqual(['shop']));expect(await(await call('merchant/certification-status','GET',undefined,{query:'?slug=shop&certified=true'})).json()).toEqual({certified:status==='VALIDATED',certificationStatus:status,certifiedSince:status==='VALIDATED'?'2026-01-01':null});expect(writes()).toEqual([]);consumed();});
 it('preserves the uncertified fallback without leaking database errors',async()=>{failure(/FROM konektag.merchant_profiles/,new Error('private'));expect(await(await call('merchant/certification-status','GET',undefined,{query:'?slug=shop'})).json()).toEqual({certified:false});consumed();});
});
