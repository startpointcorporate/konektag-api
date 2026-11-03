import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db,reset,sql,failure,consumed,writes,call,id} from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db}));
beforeEach(reset);
for(const sub of [false,true])describe(`[REST BUSINESS GET /api/marketplace/taxonomy/${sub?'subcategories':'categories'}]`,()=>{
 const source=`marketplace/taxonomy/${sub?'subcategories':'categories'}`;
 it('requires valid activity/parent selection before any taxonomy lookup',async()=>{const r=await call(source,'GET');expect(r.status).toBe(422);expect(await r.json()).toEqual({error:sub?'CATEGORY_ID_REQUIRED':'INVALID_ACTIVITY_CODE'});expect(db.query).not.toHaveBeenCalled();});
 it('returns only active, nondeleted taxonomy from a bound activity/parent query',async()=>{
  sql(new RegExp(`FROM konektag.offer_${sub?'subcategories':'categories'}`),[{id,code:'food',name_i18n:{fr:'Cuisine'}}],(v,q)=>{expect(v).toEqual([sub?id:'Restaurant']);expect(q).toContain('is_active = true');expect(q).toContain('deleted_at IS NULL');if(sub)expect(q).toContain('c.is_active = true');});
  const r=await call(source,'GET',undefined,{signedIn:false,query:sub?`?categoryId=${id}`:'?activityCode=Restaurant'});
  expect(await r.json()).toEqual({[sub?'subcategories':'categories']:[{id,code:'food',name_i18n:{fr:'Cuisine'}}]});expect(writes()).toEqual([]);consumed();
 });
});
describe('[REST BUSINESS GET /api/geo/neighborhoods]',()=>{
 it('does not enumerate locations without both city and country',async()=>{const r=await call('geo/neighborhoods','GET');expect(await r.json()).toEqual({suggestions:[]});expect(r.headers.get('cache-control')).toBe('no-store');expect(db.query).not.toHaveBeenCalled();});
 it('uses published locations in the selected country and city, binding and escaping wildcard search',async()=>{
  sql(/FROM konektag.merchant_profiles m/,[{name:'Centre',uses:3}],(v,q)=>{expect(v).toEqual(['FR','Paris','100%_']);expect(q).toContain("m.status IN ('Published','Referenced')");expect(q).toContain("ESCAPE '!'");expect(q).toContain('LIMIT 12');});
  expect(await(await call('geo/neighborhoods','GET',undefined,{query:'?country=%20FR%20&city=Paris&q=100%25_'})).json()).toEqual({suggestions:['Centre']});expect(writes()).toEqual([]);consumed();
 });
 it('distinguishes unavailable suggestions from an empty result',async()=>{failure(/FROM konektag.merchant_profiles/,new Error('private SQL'));const r=await call('geo/neighborhoods','GET',undefined,{query:'?country=FR&city=Paris'});expect(r.status).toBe(503);expect(await r.json()).toEqual({suggestions:[],unavailable:true});consumed();});
});
