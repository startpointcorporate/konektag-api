import * as pricing from '../../src/application/marketplace-transactions/restaurant-orders.ts';
import { describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { POST as restore } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/browser-activities.ts';
import { POST as createOrder, PATCH as editOrder } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import { POST as createReservation, PATCH as cancelReservation } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/reservation-requests.ts';
import { issueManagement, readManagement, MANAGEMENT_TTL_MS, MANAGEMENT_RENEW_WINDOW_MS, ownerHash } from '../../src/application/marketplace-transactions/browser-management.ts';
import { issueTracking, issueSelection } from '../../src/application/marketplace-transactions/restaurant-modes.ts';
import { FrappeSiteError, type FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
const slug='restaurant';const cap={site:'RESTODEMO',posProfile:'POS',orderType:'Takeaway' as const,channel:'Konektag'};
const seed='s'.repeat(43);const KEY='browser-creation-00000001';
const customer={name:'Client Test',phone:'+12025550130',email:'client@example.test'};
const lines=[{itemCode:'MEAL',quantity:2,unitPrice:10}];
function ctx(body:unknown,key=KEY){return createContext(new Request('https://api.test/',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)}),{slug},'127.0.0.1');}
function setup(){
 let now=new Date('2026-11-14T12:00:00Z'),counter=0,rate=true;let revision=123456;
 type Row={type:'order'|'reservation';reference:string;owner?:string;key:string;version:string;createdAt:string;state:string;snapshot:any;lastKey?:string;lastPrint?:string};
 const rows=new Map<string,Row>();const edits:string[]=[];
 const fail=(code:string):never=>{throw new FrappeSiteError('SITE_REJECTED',417,'ValidationError',code);};
 const packet=(row:Row,index?:number)=>({...(index===undefined?{}:{index}),state:row.state,type:row.type,reference:row.reference,createdAt:row.createdAt,version:row.version,snapshot:structuredClone(row.snapshot),ownerVerified:true});
 const create=(type:'order'|'reservation',args:any)=>{
  const key=args.request_key;let row=[...rows.values()].find(r=>r.type===type&&r.key===key);let replayed=!!row;
  if(!row){const reference=(type==='order'?'ORD-':'RSV-')+(++counter);const snapshot=type==='order'?{reference,status:'Open',acceptanceStatus:'Pending',trackingStatus:'Pending',createdAt:now.toISOString(),orderMode:args.order_mode,currency:'XAF',total:20,lines:[{itemCode:'MEAL',itemName:'Meal',quantity:2,unitPrice:10,amount:20}],customer:{...customer},note:'',canEdit:true,reservation:null,merchantName:'Restaurant'}:{reference,status:'Requested',date:'2026-11-15',time:'19:00',partySize:2,customer:{name:customer.name,phone:customer.phone},note:'',canCancel:true,canAssociate:false};
   row={type,reference,key,owner:args.owner_hash,version:`2026-11-14 12:00:00.${revision++}`,createdAt:now.toISOString(),state:'active',snapshot};rows.set(reference,row);}
  const normal=type==='order'?{reference:row.reference,status:row.snapshot.status,currency:'XAF',total:row.snapshot.total,lines:row.snapshot.lines,orderMode:row.snapshot.orderMode,reservation:null,replayed}:{reference:row.reference,status:row.snapshot.status,reused:replayed};
  return {...normal,...(args.owner_hash&&row.owner===args.owner_hash?packet(row):{})};
 };
 const call=vi.fn(async(method:string,args:any)=>{
  if(method.endsWith('.checkout'))return create('order',args);
  if(method.endsWith('.submit'))return create('reservation',args);
  if(method.endsWith('.browser_reconcile'))return{activities:args.activities.map((entry:any)=>{const row=entry.reference?rows.get(entry.reference):[...rows.values()].find(r=>r.type===entry.type&&r.key===entry.request_key);return row&&row.owner===entry.owner_hash?packet(row,entry.index):{index:entry.index,type:entry.type,state:entry.reference?'not_found':'pending'};})};
  if(method.endsWith('.browser_update_order')||method.endsWith('.browser_cancel_reservation')){
   const row=rows.get(args.reference);if(!row||row.owner!==args.owner_hash)fail('ACTIVITY_NOT_FOUND');
   if(!/^[a-f0-9]{64}$/.test(args.mutation_key))fail('INVALID_REQUEST');
   if(row!.lastKey===args.mutation_key){if(row!.lastPrint!==args.mutation_fingerprint)fail('IDEMPOTENCY_KEY_REUSED');return{...packet(row!),replayed:true};}
   if(row!.version!==args.expected_version)fail('VERSION_CONFLICT');
   if(row!.type==='reservation'){if(!row!.snapshot.canCancel)fail('RESERVATION_NOT_CANCELLABLE');row!.snapshot.status='Cancelled';row!.snapshot.canCancel=false;row!.state='terminal';}
   else{if(!row!.snapshot.canEdit)fail('ORDER_NOT_EDITABLE');row!.snapshot.lines=args.lines.map((l:any)=>({itemCode:l.item_code,itemName:'Meal',quantity:l.qty,unitPrice:l.price,amount:l.qty*l.price}));row!.snapshot.total=row!.snapshot.lines.reduce((n:number,l:any)=>n+l.amount,0);if(args.customer)row!.snapshot.customer=args.customer;if(args.note!==undefined)row!.snapshot.note=args.note;}
   row!.version=`2026-11-14 12:00:00.${revision++}`;row!.lastKey=args.mutation_key;row!.lastPrint=args.mutation_fingerprint;edits.push(args.reference);return packet(row!);
  }
  throw new Error('Unexpected adapter method');
 });
 const site={host:'restaurant.example',key:cap.site,call} as unknown as FrappeSite;
 const deps:TransactionDeps={env:{DATA_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({[slug]:{restaurant:cap}})},now:()=>now,site:()=>site,publicSite:()=>({host:site.host,key:cap.site,call} as any),store:()=>({checkRateLimit:async()=>rate} as any),profiles:()=>({bySlug:async()=>({establishment_id:'est',source_site:site.host,slug,publication_version:1,status:'Published',snapshot:{reservation:{enabled:true,mode:'request'}},capabilities:['restaurant'],delivered_at:now})})};
 const order=async(key=KEY,managementKey:string|null=seed)=>{const res=await createOrder(ctx({currency:'XAF',lines,customer,orderMode:'pickup',...(managementKey?{managementKey}:{})},key),deps);return{res,body:await res.json()};};
 const reservation=async()=>{const res=await createReservation(ctx({name:customer.name,phone:customer.phone,date:'2026-11-15',time:'19:00',partySize:2,managementKey:seed}),deps);return{res,body:await res.json()};};
 return {deps,call,rows,edits,order,reservation,advance:(ms:number)=>{now=new Date(now.getTime()+ms);},rate:(v:boolean)=>{rate=v;}};
}
describe('browser creator capabilities and mutations',()=>{
 it.each(['order','reservation'] as const)('issues %s management only with native creator proof, not the raw browser secret',async(type)=>{
  const t=setup();const {res,body}=await(type==='order'?t.order():t.reservation());expect(res.status).toBe(201);expect(body.activity.state).toBe('active');expect(body.activity.type).toBe(type);
  const claims=readManagement(t.deps,slug,cap,body.managementToken,type);expect(claims.ownerHash).toBe(ownerHash(slug,cap,type,seed));expect(JSON.stringify(claims)).not.toContain(customer.phone);expect(JSON.stringify(claims)).not.toContain(seed);
  expect(JSON.stringify(t.call.mock.calls)).not.toContain(seed);expect(body.activity.version).toBe('2026-11-14 12:00:00.123456');
 });
 it('requires explicit mode for managed orders, leaving unmanaged creation compatible',async()=>{
  const t=setup();const res=await createOrder(ctx({currency:'XAF',lines,customer,managementKey:seed}),t.deps);expect(res.status).toBe(400);expect(t.call).not.toHaveBeenCalled();
  const unmanaged=await t.order(KEY,null);expect(unmanaged.res.status).toBe(201);expect(unmanaged.body).not.toHaveProperty('managementToken');expect(unmanaged.body).not.toHaveProperty('activity');
 });
 it('does not late-claim a legacy creation or a different creator by replay',async()=>{
  const t=setup();await t.order();const row=[...t.rows.values()][0];row.owner=undefined;
  const denied=await t.order();expect(denied.res.status).toBe(409);expect(denied.body.error).toBe('MANAGEMENT_NOT_AVAILABLE');expect(row.owner).toBeUndefined();expect(t.rows.size).toBe(1);
 });
 it('resolves lost responses using only pending proof and idempotency key without creating twice',async()=>{
  const t=setup();const first=await t.order();const response=await restore(ctx({activities:[{type:'order',idempotencyKey:KEY,managementKey:seed}]}),t.deps);
  expect(response.status).toBe(200);const out=await response.json();expect(out.activities[0].reference).toBe(first.body.reference);expect(out.activities[0].managementToken).toBeTypeOf('string');expect(t.rows.size).toBe(1);
  const args=t.call.mock.calls.at(-1)![1];expect(args.activities[0].owner_hash).toBe(ownerHash(slug,cap,'order',seed));expect(args.activities[0]).not.toHaveProperty('customer');
 });
 it('preserves unresolved pending attempts and original indices around rejected lookup proofs',async()=>{
  const t=setup();const created=await t.reservation();
  const res=await restore(ctx({activities:[{type:'order',managementToken:issueTracking(t.deps,slug,cap,'ORD-X')},{type:'reservation',managementToken:created.body.managementToken},{type:'order',idempotencyKey:'missing-request-00001',managementKey:seed}]}),t.deps);
  const out=await res.json();expect(out.activities.map((a:any)=>[a.index,a.state])).toEqual([[0,'not_found'],[1,'active'],[2,'pending']]);expect(out.activities[1].snapshot.customer.phone).toBe(customer.phone);
  expect(t.call.mock.calls.at(-1)![1].activities.map((a:any)=>a.index)).toEqual([1,2]);
 });
 it('keeps sufficiently fresh management tokens identical and renews near-expiry or expired active proofs',async()=>{
  const t=setup();const first=await t.order();const restoreOne=async(token:string)=>(await(await restore(ctx({activities:[{type:'order',managementToken:token}]}),t.deps)).json()).activities[0];
  expect((await restoreOne(first.body.managementToken)).managementToken).toBe(first.body.managementToken);
  t.advance(MANAGEMENT_TTL_MS-MANAGEMENT_RENEW_WINDOW_MS+1);const near=await restoreOne(first.body.managementToken);expect(near.managementToken).not.toBe(first.body.managementToken);
  t.advance(MANAGEMENT_TTL_MS+1);const renewed=await restoreOne(first.body.managementToken);expect(renewed.state).toBe('active');expect(readManagement(t.deps,slug,cap,renewed.managementToken).expires).toBe(t.deps.now().getTime()+MANAGEMENT_TTL_MS);
 });
 it('returns terminal summary without renewing management; Closed with active kitchen stays active',async()=>{
  const t=setup();const first=await t.order();const row=t.rows.get(first.body.reference)!;row.snapshot.status='Closed';row.snapshot.canEdit=false;row.snapshot.trackingStatus='Preparing';
  let out=await(await restore(ctx({activities:[{type:'order',managementToken:first.body.managementToken}]}),t.deps)).json();expect(out.activities[0].state).toBe('active');
  row.state='terminal';row.snapshot.trackingStatus='Completed';t.advance(MANAGEMENT_TTL_MS+1);
  out=await(await restore(ctx({activities:[{type:'order',managementToken:first.body.managementToken}]}),t.deps)).json();expect(out.activities[0].state).toBe('terminal');expect(out.activities[0]).not.toHaveProperty('managementToken');
 });
 it('reissues direct association proof only for authoritatively eligible reservation',async()=>{
  const t=setup();const first=await t.reservation();const row=t.rows.get(first.body.reference)!;
  let out=await(await restore(ctx({activities:[{type:'reservation',managementToken:first.body.managementToken}]}),t.deps)).json();expect(out.activities[0]).not.toHaveProperty('reservationToken');
  row.snapshot.status='Confirmed';row.snapshot.canCancel=false;row.snapshot.canAssociate=true;
  out=await(await restore(ctx({activities:[{type:'reservation',managementToken:first.body.managementToken}]}),t.deps)).json();expect(out.activities[0].reservationToken).toBeTypeOf('string');expect(out.activities[0].snapshot.canCancel).toBe(false);
 });
 it.each(['order','reservation'] as const)('rejects forged, wrong-scope/type, lookup and expired %s mutation proofs before native write',async(type)=>{
  const t=setup();const first=await(type==='order'?t.order():t.reservation());
  const invoke=(token:string)=>type==='order'?editOrder(ctx({managementToken:token,expectedVersion:first.body.activity.version,currency:'XAF',lines}),t.deps):cancelReservation(ctx({action:'cancel',managementToken:token,expectedVersion:first.body.activity.version}),t.deps);
  for(const token of [issueTracking(t.deps,slug,cap,'ORD-1'),issueSelection(t.deps,slug,cap,'RSV-1'),issueManagement(t.deps,'other-restaurant',cap,type,first.body.reference,'a'.repeat(64)),issueManagement(t.deps,slug,cap,type==='order'?'reservation':'order',first.body.reference,'a'.repeat(64))])expect((await invoke(token)).status).toBe(404);
  t.advance(MANAGEMENT_TTL_MS+1);expect((await invoke(first.body.managementToken)).status).toBe(410);expect(t.edits).toHaveLength(0);
 });
 it('edits current Pending cart and contact privately with exact native version and replay',async()=>{
  const t=setup();const first=await t.order();const payload={managementToken:first.body.managementToken,expectedVersion:first.body.activity.version,currency:'XAF',lines:[{...lines[0],quantity:3}],customer:{...customer,email:'  NEW@Example.test  '},note:'Sans sel'};
  let res=await editOrder(ctx(payload,'browser-edit-00000001'),t.deps);expect(res.status).toBe(200);const edited=await res.json();expect(edited.activity.snapshot.total).toBe(30);expect(edited.activity.snapshot.customer.email).toBe('new@example.test');expect(edited.activity.version).not.toBe(first.body.activity.version);
  const args=t.call.mock.calls.at(-1)![1];expect(args.expected_version).toBe(first.body.activity.version);expect(args.mutation_key).toMatch(/^[a-f0-9]{64}$/);expect(args.lines[0]).toEqual({item_code:'MEAL',qty:3,price:10});
  res=await editOrder(ctx(payload,'browser-edit-00000001'),t.deps);expect((await res.json()).replayed).toBe(true);expect(t.edits).toHaveLength(1);
  res=await editOrder(ctx({...payload,note:'changed'},'browser-edit-00000001'),t.deps);expect(res.status).toBe(422);expect(t.edits).toHaveLength(1);
 });
 it('renews expired creator proof without changing mutation fingerprint and rejects older command after a later edit',async()=>{
  const t=setup();const first=await t.order();const payload={managementToken:first.body.managementToken,expectedVersion:first.body.activity.version,currency:'XAF',lines,note:'First'};
  const edited=await(await editOrder(ctx(payload,'browser-edit-renew-001'),t.deps)).json();t.advance(MANAGEMENT_TTL_MS+1);
  const renewed=await(await restore(ctx({activities:[{type:'order',managementToken:first.body.managementToken}]}),t.deps)).json();
  expect((await(await editOrder(ctx({...payload,managementToken:renewed.activities[0].managementToken},'browser-edit-renew-001'),t.deps)).json()).replayed).toBe(true);
  const second={...payload,managementToken:renewed.activities[0].managementToken,expectedVersion:edited.activity.version,note:'Second'};
  expect((await editOrder(ctx(second,'browser-edit-renew-002'),t.deps)).status).toBe(200);
  expect((await editOrder(ctx({...payload,managementToken:renewed.activities[0].managementToken},'browser-edit-renew-001'),t.deps)).status).toBe(409);expect(t.edits).toHaveLength(2);
 });
 it.each(['PRICE_CHANGED','ITEM_UNAVAILABLE'])('joins fresh quote only after atomic native %s edit refusal',async(code)=>{
  const t=setup();const first=await t.order();const events:string[]=[];const quote={currency:'XAF',lines:[],total:0,priceChanges:[],unavailableItems:[]};
  t.call.mockImplementation(async()=>{events.push('native');throw new FrappeSiteError('SITE_REJECTED',417,'ValidationError',code);});
  const spy=vi.spyOn(pricing,'quoteCart').mockImplementation(async()=>{events.push('quote');return quote;});
  try{const res=await editOrder(ctx({managementToken:first.body.managementToken,expectedVersion:first.body.activity.version,currency:'XAF',lines}),t.deps);expect(res.status).toBe(409);expect(await res.json()).toEqual({error:code,quote});expect(events).toEqual(['native','quote']);expect(t.edits).toHaveLength(0);}finally{spy.mockRestore();}
 });
 it('rejects stale versions, processing flags and immutable mode/link fields',async()=>{
  const t=setup();const first=await t.order();const row=t.rows.get(first.body.reference)!;const payload={managementToken:first.body.managementToken,expectedVersion:first.body.activity.version,currency:'XAF',lines};
  row.version='2026-11-14 12:00:01.123456';expect((await editOrder(ctx(payload),t.deps)).status).toBe(409);
  row.version=first.body.activity.version;row.snapshot.canEdit=false;expect((await editOrder(ctx(payload),t.deps)).status).toBe(409);
  expect((await editOrder(ctx({...payload,orderMode:'reservation'}),t.deps)).status).toBe(400);expect((await editOrder(ctx({...payload,reservationToken:'x'.repeat(100)}),t.deps)).status).toBe(400);expect(t.edits).toHaveLength(0);
 });
 it('cancels Requested exactly once and refuses confirmation races',async()=>{
  const t=setup();const first=await t.reservation();const payload={action:'cancel',managementToken:first.body.managementToken,expectedVersion:first.body.activity.version};
  const cancelled=await cancelReservation(ctx(payload,'browser-cancel-00001'),t.deps);expect(cancelled.status).toBe(200);expect((await cancelled.json()).activity.state).toBe('terminal');
  expect((await(await cancelReservation(ctx(payload,'browser-cancel-00001'),t.deps)).json()).replayed).toBe(true);expect(t.edits).toHaveLength(1);
  const other=setup();const second=await other.reservation();const row=other.rows.get(second.body.reference)!;row.snapshot.status='Confirmed';row.snapshot.canCancel=false;
  expect((await cancelReservation(ctx({...payload,managementToken:second.body.managementToken,expectedVersion:second.body.activity.version}),other.deps)).status).toBe(409);expect(other.edits).toHaveLength(0);
 });
 it('enforces batch20/type10 bounds and retains quota/unavailability as errors, not empty success',async()=>{
  const t=setup();const entry={type:'order',idempotencyKey:KEY,managementKey:seed};expect((await restore(ctx({activities:Array(11).fill(entry)}),t.deps)).status).toBe(400);
  t.rate(false);expect((await restore(ctx({activities:[entry]}),t.deps)).status).toBe(429);t.deps.store=()=>{throw new Error();};expect((await restore(ctx({activities:[entry]}),t.deps)).status).toBe(503);expect(t.rows.size).toBe(0);
 });
});
