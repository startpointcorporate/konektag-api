import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { POST as restore } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/browser-activities.ts';
import { PATCH as edit } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import { PATCH as cancel } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/reservation-requests.ts';
import { creationActivity, issueManagement } from '../../src/application/marketplace-transactions/browser-management.ts';
import { issueTracking } from '../../src/application/marketplace-transactions/restaurant-modes.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
import type { FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/marketplace-k360-browser-contract.json',import.meta.url),'utf8'));
const cap={site:'RESTODEMO',posProfile:'POS',orderType:'Takeaway' as const,channel:'Konektag'};
const deps:TransactionDeps={env:{DATA_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({restaurant:{restaurant:cap}})},now:()=>new Date('2026-11-14T12:00Z'),site:()=>({key:cap.site,host:'restaurant.example',call:async(method:string)=>{
 if(method.endsWith('.browser_reconcile'))return fixture.batch;
 if(method.endsWith('.browser_update_order'))return fixture.updated;
 if(method.endsWith('.browser_cancel_reservation'))return fixture.cancelled;
 throw new Error('Unexpected method');
}} as unknown as FrappeSite),publicSite:()=>{throw new Error();},store:()=>({checkRateLimit:async()=>true} as any),profiles:()=>({bySlug:async()=>({establishment_id:'est',source_site:'restaurant.example',slug:'restaurant',publication_version:1,status:'Published',snapshot:{},capabilities:['restaurant'],delivered_at:new Date()})})};
const token=(type:'order'|'reservation',ref:string)=>issueManagement(deps,'restaurant',cap,type,ref,fixture.ownerHash);
function ctx(data:unknown){return createContext(new Request('https://api.test/',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'cross-browser-mutation-0001'},body:JSON.stringify(data)}),{slug:'restaurant'},'127.0.0.1');}
describe('actual K360 browser-management DTO contract',()=>{
 it.each(['order','reservation'] as const)('accepts actual %s creator response and private snapshot',type=>{
  const activity=creationActivity(deps,'restaurant',cap,type,fixture.ownerHash,fixture[type+'Creation']);
  expect(activity.state).toBe('active');expect(activity.managementToken).toBeTypeOf('string');expect(activity.version).toBe('2026-11-14 12:00:00.123456');
 });
 it('preserves native original indices with rejected public-read tokens in mixed batch',async()=>{
  expect(fixture.batch.activities.map((x:any)=>x.index)).toEqual([1,3]);
  const invalid=issueTracking(deps,'restaurant',cap,'ORDER');
  const res=await restore(ctx({activities:[{type:'order',managementToken:invalid},{type:'order',managementToken:token('order','ORDER')},{type:'order',managementToken:invalid},{type:'reservation',managementToken:token('reservation','RSV-1')}]}),deps);
  expect(res.status).toBe(200);const out=await res.json();expect(out.activities.map((x:any)=>[x.index,x.state])).toEqual([[0,'not_found'],[1,'active'],[2,'not_found'],[3,'active']]);expect(out.activities[1].snapshot.canEdit).toBe(true);expect(out.activities[3].snapshot.canCancel).toBe(true);
 });
 it('accepts actual native edit and cancellation receipts',async()=>{
  const edited=await edit(ctx({managementToken:token('order','ORDER'),expectedVersion:'2026-11-14 12:00:00.123456',currency:'XAF',lines:[{itemCode:'MEAL',quantity:2,unitPrice:10}],note:'Updated'}),deps);
  expect(edited.status).toBe(200);expect((await edited.json()).activity.snapshot.note).toBe('Updated');
  const cancelled=await cancel(ctx({action:'cancel',managementToken:token('reservation','RSV-1'),expectedVersion:'2026-11-14 12:00:00.123456'}),deps);
  expect(cancelled.status).toBe(200);const out=await cancelled.json();expect(out.activity.state).toBe('terminal');expect(out.activity.snapshot.status).toBe('Cancelled');expect(out.activity).not.toHaveProperty('managementToken');
 });
});
