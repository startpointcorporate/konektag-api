import { describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { GET } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders/[token].ts';
import { FrappeSiteError, type FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
function setup() {
 const call=vi.fn(async()=>({reference:'ORD-2026-00001',status:'Open',acceptanceStatus:'Accepted',currency:'XAF',total:1000,lines:[{itemCode:'meal',itemName:'Meal',quantity:1,unitPrice:1000,amount:1000}],merchantName:'Feane',customer_name:'PRIVATE',email:'PRIVATE@example.test',k360_customer_email:'PRIVATE@example.test',phone:'+242061234567',note:'PRIVATE',qrUrl:'https://evil.test/'}));
 const ctx=createContext(new Request('https://api.test/'),{slug:'feane',token:'x'.repeat(43)},'127.0.0.1');
 const deps:TransactionDeps={env:{MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({feane:{restaurant:{site:'RESTO',posProfile:'Feane'}}})},now:()=>new Date(),store:()=>({checkRateLimit:async()=>true} as any),site:()=>({host:'resto.erp.example',call} as unknown as FrappeSite),publicSite:()=>{throw new Error();},profiles:()=>({bySlug:async()=>({establishment_id:'e',source_site:'resto.erp.example',slug:'feane',publication_version:1,status:'Published',snapshot:{},capabilities:['restaurant'],delivered_at:new Date()})})};
 return {call,ctx,deps};
}
describe('accepted client order link',()=>{
 it('returns minimal order and a native Desk QR URL from trusted routing only',async()=>{
  const t=setup();const res=await GET(t.ctx,t.deps);expect(res.status).toBe(200);
  const out=await res.json();expect(out.qrUrl).toBe('https://resto.erp.example/app/pos-restaurant-order/ORD-2026-00001');
  expect(JSON.stringify(out)).not.toContain('PRIVATE');expect(out.phone).toBeUndefined();expect(out.email).toBeUndefined();expect(out.k360_customer_email).toBeUndefined();
  expect(res.headers.get('cache-control')).toBe('no-store');expect(res.headers.get('referrer-policy')).toBe('no-referrer');expect(res.headers.get('x-robots-tag')).toContain('noindex');
 });
 it('uses the same generic refusal for invalid/expired/nonaccepted/cancelled orders',async()=>{
  const t=setup();t.ctx.params.token='invalid';expect((await GET(t.ctx,t.deps)).status).toBe(404);expect(t.call).not.toHaveBeenCalled();
  t.ctx.params.token='x'.repeat(43);t.call.mockRejectedValue(new FrappeSiteError('SITE_REJECTED',417,'ValidationError','ORDER_NOT_AVAILABLE'));
  const res=await GET(t.ctx,t.deps);expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'ORDER_NOT_AVAILABLE'});
 });
 it('rate limits and fails closed during infrastructure failure',async()=>{
  const t=setup();t.deps.store=()=>({checkRateLimit:async()=>false} as any);expect((await GET(t.ctx,t.deps)).status).toBe(429);
  t.deps.store=()=>{throw new Error();};expect((await GET(t.ctx,t.deps)).status).toBe(503);
 });
});
