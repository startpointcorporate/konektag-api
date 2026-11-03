import {beforeEach,describe,expect,it,vi} from 'vitest';
const mutations=vi.hoisted(()=>({createProduct:vi.fn(),updateProduct:vi.fn(),deleteProduct:vi.fn()}));
vi.mock('../../src/application/merchant-service.ts',()=>({merchantService:mutations}));
vi.mock('../../src/application/services/entitlement-decision-service.ts',()=>({EntitlementDeniedError:class extends Error{},entitlementResponse:vi.fn()}));
import {PATCH} from '../../src/api/routes/merchant/products/[id].ts';
beforeEach(()=>vi.clearAllMocks());
// PR #45 retires native catalogue writes. Historical reads and ERPNext remain separate.
describe('PATCH native catalogue retirement contract',()=>{
 it('requires authentication before any mutation',async()=>{
  const response=await PATCH({locals:{},params:{id:'invalid'}} as any);
  expect(response.status).toBe(401);for(const fn of Object.values(mutations))expect(fn).not.toHaveBeenCalled();
 });
 it.each(['valid','invalid-json','invalid-id','empty','enriched'])('returns the explicit retirement for authenticated %s requests without modifying historical products',async(kind)=>{
  const request=new Request('http://test/api/merchant/products',{method:'PATCH',body:kind==='invalid-json'?'{':JSON.stringify(kind==='empty'?{}:{name:'Existing product',price:10,catalogMetadata:{type:'product',visibility:'public'}})});
  const response=await PATCH({locals:{user:{id:'owner'}},params:{id:kind==='invalid-id'?'invalid':'123e4567-e89b-12d3-a456-426614174000'},request} as any);
  expect(response.status).toBe(410);expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({error:'NATIVE_CATALOG_RETIRED'});
  for(const fn of Object.values(mutations))expect(fn).not.toHaveBeenCalled();
 });
});
