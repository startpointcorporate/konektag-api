import * as restaurantService from '../../src/application/marketplace-transactions/restaurant-orders.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { POST as lookup } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/reservations/lookup.ts';
import { POST as order } from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import { issueSelection, readSelection, orderModes } from '../../src/application/marketplace-transactions/restaurant-modes.ts';
import { FrappeSiteError, type FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
const slug = 'feane-brazzaville';
const cap = { site: 'RESTODEMO', posProfile: 'Feane', channel: 'Konektag', orderType: 'Takeaway' as const };
const summary = { reference: 'RSV-2026-00001', date: '2026-11-15', time: '20:00', partySize: 2 };
const body = { currency: 'XAF', lines: [{ itemCode: 'meal', quantity: 1, unitPrice: 1000 }], customer: { name: 'Client Test', phone: '+242061234567' } };
function context(action: string, input: unknown, key = 'request-key-0000001') {
  return createContext(new Request(`https://api.test/api/public/marketplace/merchants/${slug}/restaurant/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input) }), { slug }, '127.0.0.1');
}
function setup() {
  let now = new Date('2026-11-14T10:00:00Z');
  let pickup = true, eligible = true, status = 'Open';
  let rows = [summary];
  const saved = new Map<string, { print: string; value: any }>();
  const cache = new Map<string, string>();
  const call = vi.fn(async (method: string, args: any) => {
    if (method.endsWith('.options')) return { pickup: { enabled: pickup, available: pickup }, reservation: { enabled: true } };
    if (method.endsWith('.lookup')) return { reservations: rows };
    if (!method.endsWith('.checkout')) throw new Error('Unexpected method');
    const prior = saved.get(args.request_key);
    const fail = (code: string): never => { throw new FrappeSiteError('SITE_REJECTED', 417, 'ValidationError', code); };
    if (prior) {
      if (prior.print !== args.request_fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
      return { ...prior.value, status, replayed: true };
    }
    if (!args.selection_valid) fail('RESERVATION_SELECTION_EXPIRED');
    if (args.order_mode === 'reservation' && !eligible) fail('RESERVATION_INELIGIBLE');
    if (args.order_mode === 'pickup' && !pickup) fail('PICKUP_UNAVAILABLE');
    const value = { reference: `ORD-${saved.size + 1}`, status, currency: 'XAF', total: 1000, lines: [{ itemCode: 'meal', itemName: 'Meal', quantity: 1, unitPrice: 1000, amount: 1000 }], orderMode: args.order_mode, reservation: args.order_mode === 'reservation' ? summary : null, replayed: false };
    saved.set(args.request_key, { print: args.request_fingerprint, value }); return value;
  });
  const site = { key: cap.site, host: 'restaurant.example', call } as unknown as FrappeSite;
  const deps: TransactionDeps = {
    site: () => site, publicSite: () => { throw new Error(); }, now: () => now,
    env: { DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({ [slug]: { restaurant: cap } }) },
    profiles: () => ({ bySlug: async () => ({ establishment_id: 'e', source_site: site.host, slug, publication_version: 1, status: 'Published', snapshot: {}, capabilities: ['restaurant'], delivered_at: now }) }),
    store: () => ({ getValue: async k => cache.get(k) ?? null, setValue: async (k,v) => { cache.set(k,v); }, setIfAbsent: async (k,v) => { if(cache.has(k))return false;cache.set(k,v);return true; }, deleteIfEquals: async (k,v) => { if(cache.get(k)===v)cache.delete(k); }, checkRateLimit: async () => true }),
  };
  return { deps, call, saved, cache, site, token: () => issueSelection(deps,slug,cap,summary.reference), advance: () => { now = new Date(now.getTime()+16*60_000); }, pickup: (v:boolean)=>{pickup=v;}, eligible:(v:boolean)=>{eligible=v;}, status:(v:string)=>{status=v;}, rows:(v:typeof rows)=>{rows=v;} };
}
afterEach(() => vi.restoreAllMocks());
describe('Marketplace explicit order modes', () => {
  it.each(['PRICE_CHANGED','ITEM_UNAVAILABLE'])('returns fresh quote after atomic %s refusal, never before replay',async(code)=>{
    const t=setup();const quote={currency:'XAF',lines:[],total:0,priceChanges:[],unavailableItems:[]};
    const spy=vi.spyOn(restaurantService,'quoteCart').mockResolvedValue(quote);
    t.call.mockRejectedValue(new FrappeSiteError('SITE_REJECTED',417,'ValidationError',code));
    const res=await order(context('orders',{...body,orderMode:'pickup'}),t.deps);
    expect(res.status).toBe(409);expect(await res.json()).toEqual({error:code,quote});expect(t.saved.size).toBe(0);expect(spy).toHaveBeenCalledTimes(1);
  });
  it.each(['pickup', 'reservation'])('forwards optional email privately for %s and accepts omission', async (mode) => {
    for (const email of [undefined, '  CLIENT@Example.test  ']) {
      const t = setup();
      const input = { ...body, customer: { ...body.customer, ...(email ? { email } : {}) }, orderMode: mode,
        ...(mode === 'reservation' ? { reservationToken: t.token() } : {}) };
      const res = await order(context('orders', input), t.deps);
      expect(res.status).toBe(201);
      const args = t.call.mock.calls.find(([method]) => method.endsWith('.checkout'))![1];
      if (email) expect(args.customer.email).toBe('client@example.test');
      else expect(args.customer).not.toHaveProperty('email');
      const out = await res.json();
      expect(out).not.toHaveProperty('customer'); expect(out).not.toHaveProperty('email');
      expect(JSON.stringify(out)).not.toContain('client@example.test');
    }
  });
  it.each(['pickup', 'reservation'])('rejects invalid optional email for %s before writing', async (mode) => {
    for (const email of ['invalid', '', 'x\r\nBcc: victim@example.test', 'a'.repeat(255) + '@example.test']) {
      const t = setup();
      const res = await order(context('orders', { ...body, customer: { ...body.customer, email }, orderMode: mode,
        ...(mode === 'reservation' ? { reservationToken: t.token() } : {}) }), t.deps);
      expect(res.status).toBe(400); expect(t.call).not.toHaveBeenCalled(); expect(t.saved.size).toBe(0);
    }
  });
  it('returns minimal zero/one/multiple lookup results with opaque selections', async () => {
    const t=setup();
    for (const rows of [[],[summary],[summary,{...summary,reference:'RSV-2026-00002'}]]) {
      t.rows(rows); const res=await lookup(context('reservations/lookup',{phone:body.customer.phone}),t.deps);
      expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
      const out=await res.json(); expect(out.reservations).toHaveLength(rows.length);
      for(const r of out.reservations){expect(Object.keys(r).sort()).toEqual(['date','partySize','reference','time','token']);expect(r.token).not.toContain('RSV');}
    }
  });
  it('accepts reference lookup and refuses mixed or malformed criteria', async()=>{
    const t=setup(); expect((await lookup(context('reservations/lookup',{reference:summary.reference}),t.deps)).status).toBe(200);
    for(const data of [{},{phone:'06123'},{reference:summary.reference,phone:body.customer.phone}]) expect((await lookup(context('reservations/lookup',data),t.deps)).status).toBe(400);
  });
  it('creates pickup only when enabled and available',async()=>{
    const t=setup();expect((await order(context('orders',{...body,orderMode:'pickup'}),t.deps)).status).toBe(201);
    t.pickup(false);expect((await order(context('orders',{...body,orderMode:'pickup'},'request-key-0000002'),t.deps)).status).toBe(409);
  });
  it('associates once and replays after token expiry, cache loss and later cancellation',async()=>{
    const t=setup();const input={...body,orderMode:'reservation',reservationToken:t.token()};
    expect((await order(context('orders',input),t.deps)).status).toBe(201);
    t.advance();t.cache.clear();t.eligible(false);t.status('Cancelled');
    const replay=await order(context('orders',input),t.deps);expect(replay.status).toBe(200);expect((await replay.json()).status).toBe('Cancelled');expect(t.saved.size).toBe(1);
    const invalid=await order(context('orders',input,'new-request-0000002'),t.deps);expect((await invalid.json()).error).toBe('RESERVATION_SELECTION_EXPIRED');
  });
  it('renewed token for same reservation replays; different payload conflicts durably',async()=>{
    const t=setup();expect((await order(context('orders',{...body,orderMode:'reservation',reservationToken:t.token()}),t.deps)).status).toBe(201);
    t.advance();t.cache.clear();const input={...body,orderMode:'reservation',reservationToken:t.token()};expect((await order(context('orders',input),t.deps)).status).toBe(200);
    expect((await order(context('orders',{...input,note:'changed'}),t.deps)).status).toBe(422);expect(t.saved.size).toBe(1);
  });
  it('rejects wrong restaurant, tampered token, cancelled/ineligible reservation and bad mode combinations',async()=>{
    const t=setup();const foreign=issueSelection(t.deps,'other-restaurant',cap,summary.reference);
    expect((await order(context('orders',{...body,orderMode:'reservation',reservationToken:foreign}),t.deps)).status).toBe(400);
    expect(()=>readSelection(t.deps,slug,cap,'x'.repeat(100))).toThrow('INVALID_RESERVATION_SELECTION');
    t.eligible(false);expect((await order(context('orders',{...body,orderMode:'reservation',reservationToken:t.token()}),t.deps)).status).toBe(409);
    for(const extra of [{orderMode:'reservation'},{orderMode:'pickup',reservationToken:t.token()},{reservationToken:t.token()}]) expect((await order(context('orders',{...body,...extra}),t.deps)).status).toBe(400);
  });
  it('fails new modes closed but preserves menu rollout without adapter',async()=>{
    const t=setup();t.call.mockRejectedValue(new FrappeSiteError('SITE_REJECTED',404));
    expect(await orderModes(t.site,slug,cap)).toEqual({pickup:{enabled:false,available:false},reservation:{enabled:false}});
    expect((await order(context('orders',{...body,orderMode:'pickup'}),t.deps)).status).toBe(503);
  });
  it('fails closed on Redis limiter and enforces lookup quota',async()=>{
    const t=setup();t.deps.store=()=>({checkRateLimit:async()=>false} as any);expect((await lookup(context('reservations/lookup',{reference:summary.reference}),t.deps)).status).toBe(429);
    t.deps.store=()=>{throw new Error();};expect((await lookup(context('reservations/lookup',{reference:summary.reference}),t.deps)).status).toBe(503);
  });
});
