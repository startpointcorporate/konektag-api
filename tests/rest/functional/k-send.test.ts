import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id,other,actor} from './database';
const redis=vi.hoisted(()=>({verifyOtp:vi.fn(),checkRateLimit:vi.fn(),setOtp:vi.fn()}));
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db,query:db.query,getClient:db.connect}));
vi.mock('../../../src/infrastructure/adapters/redis-adapter.ts',()=>({redisAdapter:redis}));
beforeEach(()=>{reset();vi.stubEnv('DATA_ENCRYPTION_KEY',Buffer.alloc(32,7).toString('base64'));redis.checkRateLimit.mockResolvedValue(true);redis.verifyOtp.mockResolvedValue(true);});
const row={id,sender_user_id:actor,sender_keycloak_id:'kc-owner',recipient_user_id:other,recipient_keycloak_id:'kc-recipient',recipient_name:'Grace',origin_country:'FR',destination_country:'BJ',quantity_k:'10',status:'Quoted',created_at:'2026-01-01',operation_id:null,version:2};
const dto={id,senderId:'kc-owner',recipientUserId:other,recipientName:'Grace',originCountry:'FR',destinationCountry:'BJ',quantityK:10,totalK:10,status:'Quoted',createdAt:'2026-01-01',operationId:null,totalCount:0};
const recipient={id,owner_keycloak_id:'kc-owner',recipient_user_id:other,full_name:'Grace',is_active:true,version:2};
const routes=[['k/send/index','GET','/api/k/send'],['k/send/index','POST','/api/k/send'],['k/send/balance','GET','/api/k/send/balance'],['k/send/[id]','GET','/api/k/send/{id}'],['k/send/[id]','POST','/api/k/send/{id}'],['k/send/[id]','DELETE','/api/k/send/{id}'],...['GET','POST','PUT','DELETE'].map(m=>['k/send/recipient/index',m,'/api/k/send/recipient']),['k/send/recipient/[id]/qr','GET','/api/k/send/recipient/{id}/qr']];
for(const [source,method,path] of routes)describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('refuses an anonymous sender before any wallet or beneficiary access',async()=>{expect((await call(source,method,{}, {signedIn:false})).status).toBe(401);expect(db.query).not.toHaveBeenCalled();expect(redis.verifyOtp).not.toHaveBeenCalled();});
 if(source==='k/send/recipient/index'){
  if(method==='GET'){
   it('lists only the session owner active beneficiaries',async()=>{sql(/FROM konektag.k_send_beneficiaries/,[recipient],(v,q)=>{expect(v).toEqual(['kc-owner']);expect(q).toContain('is_active=true');});expect(await(await call(source,method)).json()).toEqual([recipient]);expect(writes()).toEqual([]);consumed();});
   it('cannot read a beneficiary without exact owner scope',async()=>{sql(/FROM konektag.k_send_beneficiaries/,[],v=>expect(v).toEqual([id,'kc-owner']));expect(await(await call(source,method,undefined,{query:`?id=${id}`})).json()).toBeNull();consumed();});
  }else if(method==='POST'){
   it('upserts one owner/recipient pair and returns the persisted beneficiary',async()=>{sql(/INSERT INTO konektag.k_send_beneficiaries/,[recipient],(v,q)=>{expect(v).toEqual(['kc-owner',other,'Grace']);expect(q).toContain('ON CONFLICT (owner_keycloak_id,recipient_user_id)');});const r=await call(source,method,{recipientUserId:other,fullName:'Grace',ownerId:'victim'});expect(r.status).toBe(201);expect(await r.json()).toEqual(recipient);consumed();});
   it('rejects a missing beneficiary identity/name without persisting it',async()=>{const r=await call(source,method,{fullName:'Grace'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'K_SEND_RECIPIENT_INVALID'});expect(writes()).toEqual([]);});
  }else{
   it('requires a beneficiary id before a mutation',async()=>{const r=await call(source,method,{});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'K_SEND_RECIPIENT_ID_REQUIRED'});expect(db.query).not.toHaveBeenCalled();});
   it('uses owner and optimistic version for the beneficiary mutation',async()=>{
    sql(/FROM konektag.k_send_beneficiaries/,[recipient],v=>expect(v).toEqual([id,'kc-owner']));
    sql(/UPDATE konektag.k_send_beneficiaries/,method==='PUT'?[{...recipient,full_name:'Updated',version:3}]:[{id}],(v,q)=>{expect(v).toEqual(method==='PUT'?[id,'kc-owner','Updated',2]:[id,'kc-owner',2]);expect(q).toContain('version=version+1');if(method==='DELETE')expect(q).toContain('deleted_at=now()');});
    expect(await(await call(source,method,{fullName:'Updated',ownerId:'victim'},{query:`?id=${id}`})).json()).toEqual(method==='PUT'?{...recipient,full_name:'Updated',version:3}:{success:true});consumed();
   });
   it('does not mutate a beneficiary belonging to somebody else',async()=>{sql(/FROM konektag.k_send_beneficiaries/);await expect(call(source,method,{fullName:'Updated'},{query:`?id=${id}`})).rejects.toThrow('K_SEND_RECIPIENT_NOT_FOUND');expect(writes()).toEqual([]);consumed();});
   it('rejects an optimistic concurrency conflict rather than reporting success',async()=>{sql(/FROM konektag.k_send_beneficiaries/,[recipient]);sql(/UPDATE konektag.k_send_beneficiaries/);await expect(call(source,method,{fullName:'Updated'},{query:`?id=${id}`})).rejects.toThrow('K_SEND_RECIPIENT_CONFLICT');consumed();});
  }
 }else if(source.includes('/recipient/[id]')){
  it('returns a recipient-only QR projection after exact ownership lookup',async()=>{sql(/FROM konektag.k_send_beneficiaries/,[recipient],v=>expect(v).toEqual([id,'kc-owner']));expect(await(await call(source,method)).json()).toEqual({type:'k_send_recipient',id,recipientUserId:other});expect(writes()).toEqual([]);consumed();});
  it('does not expose a foreign beneficiary through QR',async()=>{sql(/FROM konektag.k_send_beneficiaries/);const r=await call(source,method);expect(r.status).toBe(404);expect(await r.text()).toBe('');consumed();});
 }else if(source==='k/send/balance'){
  it('returns spendable K after subtracting reservations, without leaking internal balances',async()=>{sql(/FROM konektag.parties/,[{id:'party'}],v=>expect(v).toEqual(['kc-owner']));sql(/konektag.points_balance/,[{balance:'40',reserved:'12'}],v=>expect(v).toEqual(['party']));expect(await(await call(source,method)).json()).toEqual({availableK:28});expect(writes()).toEqual([]);consumed();});
  it('returns zero when the owner has no active wallet',async()=>{sql(/FROM konektag.parties/);expect(await(await call(source,method)).json()).toEqual({availableK:0});consumed();});
 }else if(source==='k/send/index'&&method==='GET'){
  it('returns only the authenticated sender history with status and pagination',async()=>{sql(/SELECT \*, count\(\*\)/,[{...row,total_count:'4'}],v=>expect(v).toEqual(['kc-owner','Quoted',2,1]));sql(/SELECT count\(\*\)::text/,[{total:'4'}],v=>expect(v).toEqual(['kc-owner','Quoted']));expect(await(await call(source,method,undefined,{query:'?status=Quoted&limit=2&offset=1'})).json()).toEqual({data:[{...dto,totalCount:4}],total:4,limit:2,offset:1});expect(writes()).toEqual([]);consumed();});
 }else if(source==='k/send/index'){
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid quantity %s before any balance lookup',async quantityK=>{const r=await call(source,method,{quantityK,recipientUserId:other});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'K_SEND_INVALID_REQUEST'});expect(db.query).not.toHaveBeenCalled();});
  it('creates a K-only quote for the session sender using real users and exact quantities',async()=>{
   sql(/SELECT id FROM konektag.users/,[{id:other}]);sql(/FROM konektag.parties/,[{id:'party'}]);sql(/konektag.points_balance/,[{balance:20,reserved:5}]);
   sql(/SELECT id,keycloak_id,country FROM konektag.users/,[{id:actor,keycloak_id:'kc-owner',country:' fr '}]);sql(/SELECT id,keycloak_id,username,country/,[{id:other,keycloak_id:'kc-recipient',username:'Grace',country:'bj'}]);
   sql(/INSERT INTO konektag.k_send_intents/,[row],v=>expect(v).toEqual([actor,'kc-owner',other,'kc-recipient','Grace','FR','BJ',10]));
   const before=Date.now();const r=await call(source,method,{quantityK:10,recipientUserId:other,senderId:'victim'});expect(r.status).toBe(201);const body=await r.json();expect(body.send).toEqual(dto);expect(body.quote).toMatchObject({quantityK:10,totalK:10});expect(Date.parse(body.quote.expiresAt)).toBeGreaterThanOrEqual(before+300000);consumed();
  });
  it('does not create an intent when reserved points leave insufficient spendable K',async()=>{sql(/SELECT id FROM konektag.users/,[{id:other}]);sql(/FROM konektag.parties/,[{id:'party'}]);sql(/konektag.points_balance/,[{balance:20,reserved:15}]);const r=await call(source,method,{quantityK:10,recipientUserId:other});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'K_SEND_INSUFFICIENT',availableK:5});expect(writes()).toEqual([]);consumed();});
 }else{
  it('refuses another sender intent without changing wallet or verifying OTP',async()=>{sql(/SELECT \* FROM konektag.k_send_intents/,[{...row,sender_keycloak_id:'victim'}]);const r=await call(source,method,{});expect(r.status).toBe(403);expect(await r.json()).toEqual({error:'Forbidden'});expect(writes()).toEqual([]);expect(redis.verifyOtp).not.toHaveBeenCalled();consumed();});
  if(method==='GET')it('returns the exact intent projection with K units and no funding secrets',async()=>{sql(/SELECT \* FROM konektag.k_send_intents/,[{...row,funding_reference:'secret'}]);expect(await(await call(source,method)).json()).toEqual(dto);expect(writes()).toEqual([]);consumed();});
  else if(method==='DELETE'){
   it('cancels only an eligible intent with its current optimistic version',async()=>{sql(/SELECT \* FROM konektag.k_send_intents/,[row]);sql(/SELECT \* FROM konektag.k_send_intents/,[row]);sql(/UPDATE konektag.k_send_intents/,[{...row,status:'Cancelled'}],(v,q)=>{expect(v).toEqual([id,2]);expect(q).toContain("status IN ('Draft','Quoted','PendingFunding')");});expect(await(await call(source,method)).json()).toEqual({...dto,status:'Cancelled'});consumed();});
  }else{
   it('replays an already funded intent without OTP or a second wallet transfer',async()=>{sql(/SELECT \* FROM konektag.k_send_intents/,[{...row,status:'Funded'}]);expect(await(await call(source,method,{})).json()).toEqual({...dto,status:'Funded'});expect(writes()).toEqual([]);expect(redis.verifyOtp).not.toHaveBeenCalled();consumed();});
   it('refuses invalid OTP before acquiring wallets or crediting the recipient',async()=>{redis.verifyOtp.mockResolvedValue(false);sql(/SELECT \* FROM konektag.k_send_intents/,[row]);const r=await call(source,method,{authorizationId:other,otp:'000000'});expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'K_SEND_OTP_INVALID'});expect(redis.verifyOtp).toHaveBeenCalledWith(`k-send:${actor}:${id}:${other}`,'000000');expect(writes()).toEqual([]);consumed();});
   it('executes the real OTP and K transfer services, writes balanced debit/credit and commits the notification',async()=>{
    sql(/SELECT \* FROM konektag.k_send_intents/,[row]);sql(/SELECT \* FROM konektag.k_send_intents/,[row],(_,q)=>expect(q).toContain('FOR UPDATE'));
    for(const [user,party,kc] of [[actor,'party-a','kc-owner'],[other,'party-b','kc-recipient']]){sql(/SELECT id,keycloak_id,COALESCE/,[{id:user,keycloak_id:kc,display_name:user}],v=>expect(v).toEqual([user]));sql(/INSERT INTO konektag.parties/,[{id:party,keycloak_id:kc,is_active:true}],v=>expect(v).toEqual([kc,user]));}
    sql(/pg_advisory_xact_lock/,[],v=>expect(v).toEqual(['points-wallet:party-a']));sql(/pg_advisory_xact_lock/,[],v=>expect(v).toEqual(['points-wallet:party-b']));
    sql(/SELECT operation_id,party_id/);sql(/require_financial_account_active/,[],v=>expect(v).toEqual(['party-a']));sql(/konektag.points_balance/,[{balance:30,reserved:5}]);
    let operation='';sql(/INSERT INTO konektag.k_wallet_entries/,[],(v,q)=>{expect(v.slice(0,2)).toEqual(['party-a','party-b']);operation=v[2];expect(v.slice(3)).toEqual([10,`k_send:${id}`]);expect(q).toContain("'debit'");expect(q).toContain("'credit'");});
    sql(/UPDATE konektag.k_send_intents/,[{...row,status:'Funded',operation_id:'transfer-1'}],v=>expect(v).toEqual([id,2,`k-send-otp:${id}`,operation,0]));
    sql(/INSERT INTO konektag.notifications/,[],v=>{expect(v[0]).toBe('kc-recipient');expect(v[4]).toBe(`k-send-received:${id}`);});sql(/SELECT encrypted_data,locale,username/);
    const r=await call(source,method,{authorizationId:other,otp:'123456',senderId:'victim'});expect(r.status).toBe(200);expect(await r.json()).toEqual({...dto,status:'Funded',operationId:'transfer-1'});
    expect(db.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(true);expect(db.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(false);expect(db.release).toHaveBeenCalledOnce();consumed();
   });
  }
 }
});
describe('[REST BUSINESS POST /api/k/send/quote]',()=>{
 it('quotes only whole positive K with a five-minute expiry and no currency conversion',async()=>{const before=Date.now();const body=await(await call('k/send/quote','POST',{quantityK:10,currency:'EUR'})).json();expect(body).toMatchObject({quantityK:10,totalK:10});expect(Object.keys(body).sort()).toEqual(['expiresAt','quantityK','totalK']);expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before+300000);expect(db.query).not.toHaveBeenCalled();});
 it.each([0,-2,1.5,'invalid'])('rejects quantity %s without issuing a quote',async quantityK=>{const r=await call('k/send/quote','POST',{quantityK});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_K_SEND_QUANTITY'});expect(db.query).not.toHaveBeenCalled();});
});
