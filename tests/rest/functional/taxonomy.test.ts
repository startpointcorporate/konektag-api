import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db,reset,sql,failure,consumed,writes,call,id,other,pgError } from './database';
vi.mock('../../../src/infrastructure/database/pool.ts',()=>({default:db,query:db.query,getClient:db.connect}));
beforeEach(reset);
const name={fr:'Restauration',en:'Food'};
const category={id,code:'food',activity_code:'Restaurant',name_i18n:name,sort_order:2,is_active:true};
const subcategory={...category,category_id:other};
for(const sub of [false,true]) {
 const family=sub?'offer-subcategories':'offer-categories', table=sub?'offer_subcategories':'offer_categories';
 const collection=`admin/${family}/index`, item=`admin/${family}/[id]`, key=sub?'subcategory':'category', prefix=sub?'SUBCATEGORY':'CATEGORY';
 const current=sub?subcategory:category;
 for(const [source,method,path] of [[collection,'GET',`/api/admin/${family}`],[collection,'POST',`/api/admin/${family}`],[item,'GET',`/api/admin/${family}/{id}`],[item,'PATCH',`/api/admin/${family}/{id}`],[item,'DELETE',`/api/admin/${family}/{id}`]]) {
  describe(`[REST BUSINESS ${method} ${path}]`,()=>{
   it('refuses anonymous and non-admin callers without changing taxonomy',async()=>{
    expect(await (await call(source,method,{}, {signedIn:false})).json()).toEqual({error:'Unauthorized'});
    expect(db.query).not.toHaveBeenCalled(); db.role='support';
    expect((await call(source,method,{})).status).toBe(401); expect(writes()).toEqual([]);
   });
   if(source===item)it('rejects malformed identifiers before reading taxonomy',async()=>{
    const r=await call(source,method,{}, {params:{id:'bad'}}); expect(r.status).toBe(422);
    expect(await r.json()).toEqual({error:`INVALID_${prefix}_ID`}); expect(db.query).toHaveBeenCalledOnce();
   });
   if(method==='GET') {
    it('returns only the selected active-record projection with bound scope',async()=>{
     if(source===item)sql(new RegExp(`SELECT \\* FROM konektag.${table}`),[current],v=>expect(v).toEqual([id]));
     else sql(new RegExp(`FROM konektag.${table}`),[current],(v,q)=>{expect(q).toContain('deleted_at IS NULL');expect(v).toEqual(sub?[]:['Restaurant']);});
     const r=await call(source,method,undefined,{query:source===collection&&!sub?'?activityCode=Restaurant':''});
     expect(await r.json()).toEqual(source===item?{[key]:current}:{[sub?'subcategories':'categories']:[current]}); expect(writes()).toEqual([]); consumed();
    });
    if(source===item)it('returns the explicit missing-record error',async()=>{sql(new RegExp(`FROM konektag.${table}`));const r=await call(source,method);expect(r.status).toBe(404);expect(await r.json()).toEqual({error:`${prefix}_NOT_FOUND`});consumed();});
    else it('rejects invalid filter values before the list query',async()=>{const r=await call(source,method,undefined,{query:sub?'?categoryId=bad':'?activityCode=Unknown'});expect(r.status).toBe(422);expect(await r.json()).toEqual({error:sub?'INVALID_CATEGORY_ID':'INVALID_ACTIVITY_CODE'});expect(db.query).toHaveBeenCalledOnce();});
   } else if(method==='DELETE') {
    it('disables the record without physically deleting historical taxonomy',async()=>{
     sql(new RegExp(`UPDATE konektag.${table}`),[{id}],(v,q)=>{expect(v).toEqual([id]);expect(q).toContain('is_active=false');expect(q).toContain('deleted_at IS NULL');});
     expect(await (await call(source,method)).json()).toEqual({success:true});expect(writes()).toHaveLength(1);consumed();
    });
    it('does not claim success for a missing record',async()=>{sql(new RegExp(`UPDATE konektag.${table}`));const r=await call(source,method);expect(r.status).toBe(404);expect(await r.json()).toEqual({error:`${prefix}_NOT_FOUND`});consumed();});
   } else {
    it('rejects invalid fields and malformed JSON without a write',async()=>{
     for(const body of [{}, {unexpected:'field'}]){const r=await call(source,method,body);expect(r.status).toBe(422);expect(await r.json()).toHaveProperty('errors');}
     const r=await call(source,method,{}, {raw:'{'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_JSON'});expect(writes()).toEqual([]);
    });
    const prepare=(duplicate=false)=>{
     if(method==='PATCH')sql(new RegExp(`SELECT \\* FROM konektag.${table}`),[current]);
     if(sub)sql(/SELECT id FROM konektag.offer_categories/,[{id:other}],v=>expect(v).toEqual([other]));
     const pattern=new RegExp(`${method==='POST'?'INSERT INTO':'UPDATE'} konektag.${table}`);
     if(duplicate)failure(pattern,pgError('23505'));
     else sql(pattern,[{...current,code:'updated'}],v=>expect(v).toEqual(method==='POST'?(sub?[other,'updated',JSON.stringify(name),0,true]:['updated','Restaurant',JSON.stringify(name),0,true]):(sub?[id,other,'updated',JSON.stringify(name),2,true]:[id,'updated','Restaurant',JSON.stringify(name),2,true])));
    };
    it('persists validated fields and returns the database record with server defaults',async()=>{
     prepare();const body=method==='PATCH'?{code:'updated'}:sub?{categoryId:other,code:'updated',nameI18n:name}:{activityCode:'Restaurant',code:'updated',nameI18n:name};
     const r=await call(source,method,body);expect(r.status).toBe(method==='POST'?201:200);expect(await r.json()).toEqual({[key]:{...current,code:'updated'}});consumed();
    });
    it('preserves a duplicate-code conflict instead of claiming persistence',async()=>{
     prepare(true);const body=method==='PATCH'?{code:'updated'}:sub?{categoryId:other,code:'updated',nameI18n:name}:{activityCode:'Restaurant',code:'updated',nameI18n:name};
     const r=await call(source,method,body);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:`${prefix}_CODE_EXISTS`});consumed();
    });
    if(method==='PATCH')it('prevents changing the activity/category of a taxonomy record already in use',async()=>{
     sql(new RegExp(`SELECT \\* FROM konektag.${table}`),[current]);sql(/SELECT 1 FROM konektag.merchant_products/,[{exists:1}],v=>expect(v).toEqual([id]));
     const r=await call(source,method,sub?{categoryId:id}:{activityCode:'Hotel'});expect(r.status).toBe(409);expect(await r.json()).toEqual({error:sub?'SUBCATEGORY_CATEGORY_IN_USE':'CATEGORY_ACTIVITY_IN_USE'});expect(writes()).toEqual([]);consumed();
    });
    if(sub)it('requires a real active parent category before insertion or update',async()=>{
     if(method==='PATCH')sql(new RegExp(`SELECT \\* FROM konektag.${table}`),[current]);sql(/SELECT id FROM konektag.offer_categories/);
     const r=await call(source,method,method==='PATCH'?{code:'updated'}:{categoryId:other,code:'updated',nameI18n:name});expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'CATEGORY_NOT_FOUND'});expect(writes()).toEqual([]);consumed();
    });
   }
  });
 }
}
