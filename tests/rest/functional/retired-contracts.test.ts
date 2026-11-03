import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,consumed,writes,call} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(reset);
const retired=[
 ['cash-agent/index','GET','/api/cash-agent',{error:'CASH_AGENT_DISABLED',message:'Le service depot ou retrait d especes est indisponible.'}],
 ['cash-agent/index','POST','/api/cash-agent',{error:'CASH_AGENT_DISABLED',message:'Le service depot ou retrait d especes est indisponible.'}],
 ['pay/payments/confirm','GET','/api/pay/payments/confirm',{error:'UNIFIED_PAYMENT_CHECKOUT_REQUIRED'}],
 ['qr/confirm','GET','/api/qr/confirm',{error:'QR_OTP_CHECKOUT_REQUIRED'}],
 ['admin/mobile-money/acquisitions','POST','/api/admin/mobile-money/acquisitions',{error:'LEGACY_MANUAL_ACQUISITION_RETIRED',replacement:'/api/admin/mobile-money-queue/api-payments/{id}/confirm'}],
 ['growth/contents','POST','/api/growth/contents',{error:'CONTENT_LINK_RETIRED',message:'Utilisez les Reels et le partage natif de leur contenu.'}],
 ['merchant/cards/sell','POST','/api/merchant/cards/sell',{error:'CARD_SALE_DECLARATION_REQUIRED',message:'Utilisez la declaration de vente avec la liste des cartes et la preuve.'}],
] as const;
for(const [source,method,path,body] of retired)describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('preserves the explicit retirement and replacement contract without any persistent effect',async()=>{
  for(const input of [{},{amount:100,userId:'victim',confirmed:true}]){const r=await call(source,method,input);expect(r.status).toBe(410);expect(await r.json()).toEqual(body);}
  expect(db.query).not.toHaveBeenCalled();expect(writes()).toEqual([]);
 });
 if(source==='merchant/cards/sell')it('requires a seller identity even for the retired browser flow',async()=>{const r=await call(source,method,{}, {signedIn:false});expect(r.status).toBe(401);expect(await r.json()).toMatchObject({error:'UNAUTHORIZED'});expect(db.query).not.toHaveBeenCalled();});
});
for(const [source,method,path] of [
 ['admin/pro-subscriptions/index','GET','/api/admin/pro-subscriptions'],['admin/pro-subscriptions/index','POST','/api/admin/pro-subscriptions'],
 ['admin/pro-subscriptions/[id]','PUT','/api/admin/pro-subscriptions/{id}'],['admin/pro-subscriptions/[id]','DELETE','/api/admin/pro-subscriptions/{id}'],
])describe(`[REST BUSINESS ${method} ${path}]`,()=>{
 it('requires central administration and rejects a database role change before subscription access',async()=>{
  const anonymous=await call(source,method,{}, {signedIn:false});expect(anonymous.status).toBe(403);expect(await anonymous.json()).toMatchObject({error:'FORBIDDEN'});expect(db.query).not.toHaveBeenCalled();
  db.role='admin_technique';const denied=await call(source,method,{});expect(denied.status).toBe(403);expect(await denied.json()).toMatchObject({error:'FORBIDDEN'});expect(writes()).toEqual([]);
 });
 if(method==='GET')it('returns effective expiry and bounds central subscription pagination',async()=>{
  sql(/FROM konektag.merchant_pro_subscriptions s/,[{id:'subscription',effective_status:'EXPIRED'}],(v,q)=>{expect(v).toEqual([200,0]);expect(q).toContain("s.subscription_end<=CURRENT_DATE THEN 'EXPIRED'");});sql(/SELECT count\(\*\)/,[{total:1}]);
  expect(await(await call(source,method,undefined,{query:'?limit=999&offset=-2'})).json()).toEqual({subscriptions:[{id:'subscription',effective_status:'EXPIRED'}],total:1});expect(writes()).toEqual([]);consumed();
 });
 else it('refuses direct activation/change/deletion and points to the approved activation flow',async()=>{const r=await call(source,method,{status:'ACTIVE'});expect(r.status).toBe(405);expect(await r.json()).toEqual({error:'USE_MERCHANT_PRO_ACTIVATION'});expect(writes()).toEqual([]);});
});
