import { beforeEach, describe, expect, it, vi } from 'vitest';
import { context } from './helpers';
const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: m }));
import * as merchants from '../../src/api/routes/favorites/merchants';
import * as users from '../../src/api/routes/favorites/users';
beforeEach(() => { vi.resetAllMocks(); m.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); })); });
for (const [domain,handlers] of [['merchants',merchants],['users',users]] as const) describe(`favorites ${domain}`, () => {
  const path = `/api/favorites/${domain}`;
  for (const method of ['GET','POST','DELETE'] as const) it(`${method} refuses anonymous access before any data access`, async () => {
    const response = await handlers[method](context(path,{},false)); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' }); expect(m.query).not.toHaveBeenCalled();
  });
  it('lists only the authenticated owner favorites', async () => {
    m.query.mockResolvedValue({ rows: [{ id: 'favorite-1' }] }); expect(await (await handlers.GET(context(path))).json()).toEqual([{ id: 'favorite-1' }]);
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), ['kc-owner']);
  });
  it('requires a target before any insert', async () => {
    const response = await handlers.POST(context(path,{})); expect(response.status).toBe(400); expect(await response.json()).toHaveProperty('error'); expect(m.query).not.toHaveBeenCalled();
  });
  it('deletes only a favorite belonging to the session owner', async () => {
    m.query.mockResolvedValue({ rowCount: 1 }); expect(await (await handlers.DELETE(context(path+'?id=favorite-1&userId=victim'))).json()).toEqual({ success: true });
    expect(m.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE .*WHERE id\s*=\s*\$1 AND user_id\s*=\s*\$2/), ['favorite-1','kc-owner']);
  });
  it('does not delete anything when the id is absent', async () => {
    const response = await handlers.DELETE(context(path)); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Paramètre id requis' }); expect(m.query).not.toHaveBeenCalled();
  });
  it('preserves not-found when the favorite does not belong to the caller', async () => {
    const response = await handlers.DELETE(context(path+'?id=foreign')); expect(response.status).toBe(404);
    expect(await response.json()).toEqual(domain==='merchants'?{ error: 'Favori introuvable' }:{ success:false });
    expect(m.query.mock.calls[0][1]).toEqual(['foreign','kc-owner']);
  });
});
it('inserts a merchant favorite for the authenticated owner and returns its id', async () => {
  m.query.mockResolvedValue({ rows: [{ id:'favorite-1' }] }); const response = await merchants.POST(context('/api/favorites/merchants',{ merchantProfileId:'shop-1', userId:'victim' }));
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ success:true,id:'favorite-1' });
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'),['kc-owner','shop-1']);
});
it('preserves the merchant duplicate conflict without claiming a new favorite', async () => {
  const response = await merchants.POST(context('/api/favorites/merchants',{ merchantProfileId:'shop-1' }));
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error:'Déjà dans vos favoris' });
});
it.each([false,true])('adds a published user favorite with replay=%s', async replay => {
  m.query.mockResolvedValueOnce({ rows:[{id:'target-1',keycloak_id:'kc-target'}] }).mockResolvedValueOnce({rows:replay?[]:[{id:'favorite-1'}]});
  const response=await users.POST(context('/api/favorites/users',{userId:'target-1'})); expect(response.status).toBe(replay?200:201);
  expect(await response.json()).toEqual({success:true,id:replay?null:'favorite-1',alreadyFavorite:replay});
  expect(m.query).toHaveBeenNthCalledWith(1,expect.stringContaining("upp.status='published'"),['target-1']);
  expect(m.query).toHaveBeenNthCalledWith(2,expect.stringContaining('ON CONFLICT'),['kc-owner','target-1']);
});
it('refuses self-favorite before inserting', async () => {
  m.query.mockResolvedValue({rows:[{id:'self',keycloak_id:'kc-owner'}]}); const response=await users.POST(context('/api/favorites/users',{userId:'self'}));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({error:'CANNOT_FAVORITE_SELF'}); expect(m.query).toHaveBeenCalledOnce();
});
it('refuses an unpublished or missing target before inserting', async () => {
  const response=await users.POST(context('/api/favorites/users',{userId:'unknown'}));
  expect(response.status).toBe(404); expect(await response.json()).toEqual({error:'USER_NOT_FOUND'}); expect(m.query).toHaveBeenCalledOnce();
});
