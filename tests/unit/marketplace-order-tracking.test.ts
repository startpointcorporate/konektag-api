import { describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { POST as lookup } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders/lookup.ts';
import { POST as checkout } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import { GET as detail } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders/[token].ts';
import { issueSelection, issueTracking, readTracking, ORDER_TRACKING_TTL_MS } from '../../src/application/marketplace-transactions/restaurant-modes.ts';
import { FrappeSiteError, type FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
const slug='restaurant';const cap={site:'RESTO',posProfile:'POS',channel:'Konektag',orderType:'Takeaway' as const};
function ctx(body?:unknown,token?:string){return createContext(new Request('https://api.test/api/public/marketplace/merchants/restaurant/restaurant/orders/lookup',{method:body?'POST':'GET',headers:{'content-type':'application/json','idempotency-key':'tracking-request-00001'},...(body?{body:JSON.stringify(body)}:{})}),{slug,token},'127.0.0.1');}
function setup(){
 let now=new Date('2026-11-14T12:00:00Z');
 let summary={reference:'ORD-1',status:'Open',acceptanceStatus:'Pending',trackingStatus:'Pending',createdAt:'2026-11-14T13:00:00+01:00',orderMode:'pickup',currency:'XAF',total:20};
 let rows:any[]=[summary];
 const pii={customer_name:'PRIVATE',phone:'+242069123456',email:'private@example.test',note:'PRIVATE',k360_customer_email:'private@example.test'};
 const lines=[{itemCode:'MEAL',itemName:'Meal',quantity:2,unitPrice:10,amount:20}];
 const call=vi.fn(async(method:string,args:any)=>{
  if(method.endsWith('.order_lookup'))return{orders:rows.map(r=>({...r,...pii}))};
  if(method.endsWith('.tracking_order'))return{...summary,...pii,merchantName:'Restaurant',lines};
  if(method.endsWith('.client_order'))return{...summary,...pii,merchantName:'Restaurant',lines};
  if(method.endsWith('.checkout'))return{reference:'ORD-1',status:'Open',currency:'XAF',total:20,lines,orderMode:args.order_mode,reservation:null,replayed:false};
  throw new Error('Unexpected method');
 });
 const site={key:cap.site,host:'restaurant.example',call} as unknown as FrappeSite;
 const deps:TransactionDeps={site:()=>site,publicSite:()=>{throw new Error();},now:()=>now,env:{DATA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({[slug]:{restaurant:cap}})},store:()=>({checkRateLimit:async()=>true} as any),profiles:()=>({bySlug:async()=>({establishment_id:'est',source_site:site.host,slug,publication_version:1,status:'Published',snapshot:{},capabilities:['restaurant'],delivered_at:now})})};
 return {deps,call,summary,rows:(v:any[])=>{rows=v;},state:(value:Partial<typeof summary>)=>{summary={...summary,...value};},advance:()=>{now=new Date(now.getTime()+ORDER_TRACKING_TTL_MS+1);},token:()=>issueTracking(deps,slug,cap,'ORD-1')};
}
describe('Marketplace order tracking',()=>{
 it.each([{reference:'ORD-1'},{phone:'+242069123456'},{email:'  CLIENT@Example.test  '}])('looks up $reference$phone$email minimally with an opaque token',async(search)=>{
  const t=setup();const res=await lookup(ctx(search),t.deps);expect(res.status).toBe(200);const out=await res.json();expect(out.orders).toHaveLength(1);
  expect(Object.keys(out.orders[0]).sort()).toEqual(['acceptanceStatus','createdAt','currency','orderMode','reference','status','token','total','trackingStatus']);
  expect(readTracking(t.deps,slug,cap,out.orders[0].token)).toBe('ORD-1');expect(JSON.stringify(out)).not.toContain('PRIVATE');expect(JSON.stringify(out)).not.toContain('private@example.test');
  if('email' in search)expect(t.call.mock.calls[0][1].email).toBe('client@example.test');
 });
 it('returns zero/one/multiple orders without exposing contact details',async()=>{
  const t=setup();for(const rows of [[],[t.summary],[t.summary,{...t.summary,reference:'ORD-2'}]]){t.rows(rows);const res=await lookup(ctx({phone:'+242069123456'}),t.deps);expect((await res.json()).orders).toHaveLength(rows.length);}
 });
 it('rejects invalid/mixed criteria before the adapter',async()=>{
  const t=setup();for(const search of [{},{email:'invalid'},{phone:'06123'},{reference:'ORD-1',email:'client@example.test'}])expect((await lookup(ctx(search),t.deps)).status).toBe(400);expect(t.call).not.toHaveBeenCalled();
 });
 it.each(['Pending','Accepted','Preparing','Ready','Completed','Cancelled'])('shows real %s state from the tracking adapter without PII',async(state)=>{
  const t=setup();const acceptanceStatus=state==='Pending'?'Pending':state==='Cancelled'?'Rejected':'Accepted';t.state({trackingStatus:state,acceptanceStatus,status:state==='Cancelled'?'Cancelled':'Open'});
  const res=await detail(ctx(undefined,t.token()),t.deps);expect(res.status).toBe(200);const out=await res.json();expect(out.trackingStatus).toBe(state);
  expect(out.qrUrl).toBe(acceptanceStatus==='Accepted'?'https://restaurant.example/app/pos-restaurant-order/ORD-1':null);
  expect(JSON.stringify(out)).not.toContain('PRIVATE');expect(JSON.stringify(out)).not.toContain('private@example.test');
  expect(res.headers.get('cache-control')).toBe('no-store');expect(res.headers.get('referrer-policy')).toBe('no-referrer');
 });
 it('rejects expired/wrong restaurant/POS/purpose tracking proofs before reading native order',async()=>{
  const t=setup();const expired=t.token();t.advance();
  const tokens=[expired,issueTracking(t.deps,'other-restaurant',cap,'ORD-1'),issueTracking(t.deps,slug,{...cap,posProfile:'OTHER'},'ORD-1'),issueSelection(t.deps,slug,cap,'RSV-1'),'x'.repeat(80)];
  for(const token of tokens){const res=await detail(ctx(undefined,token),t.deps);expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'ORDER_NOT_AVAILABLE'});}
  expect(t.call).not.toHaveBeenCalled();
 });
 it('preserves Accepted-only native share links while exposing enriched tracking fields',async()=>{
  const t=setup();expect((await detail(ctx(undefined,'a'.repeat(43)),t.deps)).status).toBe(404);
  t.state({acceptanceStatus:'Accepted',trackingStatus:'Preparing'});const out=await(await detail(ctx(undefined,'a'.repeat(43)),t.deps)).json();expect(out.trackingStatus).toBe('Preparing');expect(out.createdAt).toBe(t.summary.createdAt);
  t.state({status:'Cancelled'});expect((await detail(ctx(undefined,'a'.repeat(43)),t.deps)).status).toBe(404);
 });
 it('issues tracking proof on explicit checkout immediately before acceptance',async()=>{
  const t=setup();const res=await checkout(ctx({currency:'XAF',lines:[{itemCode:'MEAL',quantity:2,unitPrice:10}],customer:{name:'Client Test',phone:'+242069123456'},orderMode:'pickup'}),t.deps);
  expect(res.status).toBe(201);const out=await res.json();expect(readTracking(t.deps,slug,cap,out.trackingToken)).toBe('ORD-1');
  expect((await(await detail(ctx(undefined,out.trackingToken),t.deps)).json()).trackingStatus).toBe('Pending');
 });
 it('maps scope-not-found, adapter quotas and limiter outage safely',async()=>{
  const t=setup();t.call.mockRejectedValue(new FrappeSiteError('SITE_REJECTED',417,'ValidationError','ORDER_NOT_AVAILABLE'));expect((await detail(ctx(undefined,t.token()),t.deps)).status).toBe(404);
  t.call.mockRejectedValue(new FrappeSiteError('SITE_REJECTED',417,'ValidationError','TOO_MANY_REQUESTS'));expect((await lookup(ctx({reference:'ORD-1'}),t.deps)).status).toBe(429);expect((await detail(ctx(undefined,t.token()),t.deps)).status).toBe(429);
  t.deps.store=()=>{throw new Error();};expect((await lookup(ctx({reference:'ORD-1'}),t.deps)).status).toBe(503);
 });
});
