import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({catalog:vi.fn()}));
vi.mock('../../src/api/routes/public/boost-cpm.ts',()=>({GET:mocks.catalog}));
import {POST} from '../../src/api/routes/public/boost-estimate.ts';

const catalog={countries:[{code:'CG',name:'Congo',billingCompany:'Konektag Congo',
 channels:[{channel:'facebook',currency:'XAF',cpmLow:1000,cpmHigh:1500,referenceMonth:'2026-11',stale:false}]}]};
const post=(payload:unknown)=>POST({request:new Request('https://example.test/api/public/boost-estimate',
 {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})} as any);
beforeEach(()=>{mocks.catalog.mockReset();mocks.catalog.mockResolvedValue(Response.json(catalog));});
describe('public CPM estimate',()=>{
 it('calculates the indicative range and gets the billing owner from the server',async()=>{
  const res=await post({targetCountry:'CG',network:'facebook',budget:20000,currency:'XAF'});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({billingCompany:'Konektag Congo',
    estimatedImpressions:{min:13333,max:20000},estimated:true,guaranteed:false});
 });
 it('rejects a client-supplied billing company',async()=>{
  const res=await post({targetCountry:'CG',network:'facebook',budget:20000,currency:'XAF',billingCompany:'Other'});
  expect(res.status).toBe(400);
 });
 it('rejects currency mismatch rather than applying an invented FX rate',async()=>{
  const res=await post({targetCountry:'CG',network:'facebook',budget:20000,currency:'EUR'});
  expect(res.status).toBe(422);
 });
 it('hides unavailable networks',async()=>{
  const res=await post({targetCountry:'CG',network:'tiktok',budget:20000,currency:'XAF'});
  expect(res.status).toBe(404);
 });
 it('propagates catalogue unavailability without claiming impressions',async()=>{
  mocks.catalog.mockResolvedValue(Response.json({error:'CPM_SERVICE_UNAVAILABLE'},{status:503}));
  const res=await post({targetCountry:'CG',network:'facebook',budget:20000,currency:'XAF'});
  expect(res.status).toBe(503);
 });
});
