import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { GET as clientOrder } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders/[token].ts';
import { POST as lookup } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/reservations/lookup.ts';
import { POST as checkout } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import { POST as orderLookup } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders/lookup.ts';
import { orderModes, issueSelection, issueTracking } from '../../src/application/marketplace-transactions/restaurant-modes.ts';
import type { FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
// Exported by actual K360 Python functions with its DB/native POS unit harness.
// This checks DTO serialization across languages, not a deployed integration.
const fixture=JSON.parse(readFileSync(new URL('../fixtures/marketplace-k360-order-contract.json',import.meta.url),'utf8'));
const cap={site:'RESTO',posProfile:'POS',orderType:'Takeaway' as const,channel:'Konektag'};
const seenCustomers: any[] = [];
const site={key:'RESTO',host:'restodemo.example',call:async(method:string,args:any)=>{
 if(method.endsWith('.options'))return fixture.options;
 if(method.endsWith('.lookup'))return fixture.lookup;
 if(method.endsWith('.order_lookup'))return fixture.orderLookup;
 if(method.endsWith('.tracking_order'))return fixture.tracking;
 if(method.endsWith('.client_order'))return fixture.client;
 if(method.endsWith('.checkout')){seenCustomers.push(args.customer);return fixture[args.order_mode];}
 throw new Error('Unexpected adapter method');
}} as unknown as FrappeSite;
const deps:TransactionDeps={env:{DATA_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({restaurant:{restaurant:cap}})},now:()=>new Date('2026-11-14T10:00Z'),site:()=>site,publicSite:()=>{throw new Error();},store:()=>({checkRateLimit:async()=>true} as any),profiles:()=>({bySlug:async()=>({establishment_id:'est',source_site:site.host,slug:'restaurant',publication_version:1,status:'Published',snapshot:{},capabilities:['restaurant'],delivered_at:new Date()})})};
function ctx(action:string,data?:unknown){return createContext(new Request('https://api.test/'+action,{method:data?'POST':'GET',headers:{'content-type':'application/json','idempotency-key':'cross-language-test-0001'},...(data?{body:JSON.stringify(data)}:{})}),{slug:'restaurant',token:'a'.repeat(43)},'127.0.0.1');}
describe('actual K360 adapter DTO contract',()=>{
 it('accepts native options, lookup and opaque selection',async()=>{
  expect(await orderModes(site,'restaurant',cap)).toEqual(fixture.options.orderModes);
  const res=await lookup(ctx('lookup',{reference:'RSV-1'}),deps);expect(res.status).toBe(200);
  const out=await res.json();expect(out.reservations[0].reference).toBe('RSV-1');expect(out.reservations[0].token).toBeTypeOf('string');
 });
 it.each(['pickup','reservation'])('accepts native %s checkout JSON',async(mode)=>{
  const body={currency:'XAF',lines:[{itemCode:'MEAL',quantity:2,unitPrice:10}],customer:{name:'Client Test',phone:'+242069123456'},orderMode:mode,...(mode==='reservation'?{reservationToken:issueSelection(deps,'restaurant',cap,'RSV-1')}:{})};
  const res=await checkout(ctx('orders',body),deps);expect(res.status).toBe(201);
  const out=await res.json();expect(out.orderMode).toBe(mode);expect(out.total).toBe(20);expect(out.reservation).toEqual(fixture[mode].reservation);
 });
 it('accepts valid/absent email through the native contract and refuses invalid email before adapter',async()=>{
  expect(fixture.optionalEmailVerified).toBe(true);
  for(const email of [undefined,'  CLIENT@Example.test  ']){
   const res=await checkout(ctx('orders',{currency:'XAF',lines:[{itemCode:'MEAL',quantity:2,unitPrice:10}],customer:{name:'Client Test',phone:'+242069123456',...(email?{email}:{})},orderMode:'pickup'}),deps);
   expect(res.status).toBe(201);const sent=seenCustomers.at(-1);
   if(email)expect(sent.email).toBe('client@example.test');else expect(sent).not.toHaveProperty('email');
   expect(JSON.stringify(await res.json())).not.toContain('client@example.test');
  }
  const count=seenCustomers.length;
  const res=await checkout(ctx('orders',{currency:'XAF',lines:[{itemCode:'MEAL',quantity:2,unitPrice:10}],customer:{name:'Client Test',phone:'+242069123456',email:'invalid'},orderMode:'pickup'}),deps);
  expect(res.status).toBe(400);expect(seenCustomers.length).toBe(count);
 });
 it('accepts real Python order lookup and tracking state without public contacts',async()=>{
  const res=await orderLookup(ctx('lookup',{reference:'ORDER'}),deps);expect(res.status).toBe(200);const result=await res.json();
  expect(result.orders[0].reference).toBe('ORDER');expect(result.orders[0].trackingStatus).toBe(fixture.orderLookup.orders[0].trackingStatus);
  const request=ctx('tracking');request.params.token=issueTracking(deps,'restaurant',cap,'ORDER');
  const tracking=await clientOrder(request,deps);expect(tracking.status).toBe(200);const out=await tracking.json();
  expect(out.trackingStatus).toBe(fixture.tracking.trackingStatus);expect(out.createdAt).toBe(fixture.tracking.createdAt);expect(JSON.stringify(out)).not.toContain('client@example.test');
 });
 it('accepts native public accepted-order JSON and adds trusted QR URL',async()=>{
  const res=await clientOrder(ctx('client'),deps);expect(res.status).toBe(200);
  const out=await res.json();expect(out.reference).toBe(fixture.client.reference);expect(out.qrUrl).toBe('https://restodemo.example/app/pos-restaurant-order/ORDER');
 });
});
