// Marketplace read (API #24) against a real, isolated PostgreSQL.
// Run with `npm run test:marketplace:pg`, outside the default suite, with
// MARKETPLACE_PG_TEST_URL pointing at a throwaway database named konektag_test
// (owner rights to apply migration 228). Never production.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import type { TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
import * as quoteRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/quote.ts';
import * as orderRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/orders.ts';
import * as menuRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/restaurant/menu.ts';
import * as availabilityRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/availability.ts';
import * as reservationRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/reservations.ts';
import * as roomsRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/hotel/rooms.ts';
import * as profileRoute from '../../src/api/routes/public/marketplace/merchants/[slug]/index.ts';
import type { RequestContext } from '../../src/api/http.ts';

// The Marketplace route handlers, with injected dependencies.
type Ctx = RequestContext;
const restaurantHandlers = (deps: TransactionDeps) => ({ quote: (c: Ctx) => quoteRoute.POST(c, deps), order: (c: Ctx) => orderRoute.POST(c, deps) });
const hotelHandlers = (deps: TransactionDeps) => ({ availability: (c: Ctx) => availabilityRoute.GET(c, deps), reserve: (c: Ctx) => reservationRoute.POST(c, deps) });
const catalogueHandlers = (deps: TransactionDeps) => ({ menu: (c: Ctx) => menuRoute.GET(c, deps), rooms: (c: Ctx) => roomsRoute.GET(c, deps) });
const profileHandler = (deps: TransactionDeps) => (c: Ctx) => profileRoute.GET(c, deps);
import { ProjectionUnavailable, sqlPublishedProfiles } from '../../src/application/marketplace-transactions/published-profiles.ts';

import { publishedMarketplace } from '../../src/application/services/published-marketplace.ts';
import { GET as listGET } from '../../src/api/routes/public/marketplace/merchants/index.ts';
import { GET as facetsGET } from '../../src/api/routes/public/marketplace/facets/index.ts';

const url = process.env.MARKETPLACE_PG_TEST_URL;
const isolated = !!url && new URL(url).pathname === '/konektag_test';
const MIGRATION = 'src/lib/infrastructure/database/migrations/228_marketplace_published_establishments.sql';

if (!isolated) throw new Error('MARKETPLACE_PG_TEST_URL must point at a throwaway database named konektag_test');

describe('Marketplace projection on PostgreSQL (migration 228)', () => {
  let owner: pg.Pool;
  let reader: pg.Pool;
  const snapshot = (slug: string) => ({
    establishment_id: '11111111-1111-4111-8111-111111111111', establishment_name: 'Feane', description: 'Cuisine maison', slug,
    country_code: 'CG', city_id: 'cg-bzv', city_name: 'Brazzaville', city_slug: 'brazzaville', address: 'Avenue Foch', latitude: '-4.2634', longitude: '15.2429',
    merchant: { merchant_id: 'm-1', merchant_name: 'Groupe Démo', logo: '/files/logo.png', public_phone: '+242060000001', website: 'https://demo.example' },
    activities: [{ activity_code: 'restaurant', activity_name: 'Restaurant' }],
    opening_hours: [{ weekday: 'Tuesday', closed: 0, opens_at: '11:00:00', closes_at: '22:30:00' }],
    media: [{ file: '/files/salle.jpg', alt_text: 'Salle', caption: null }], social_links: [],
  });
  const insert = (id: string, slug: string, status: string, snap: unknown, caps: string[], version = 1) => owner.query(
    `INSERT INTO konektag.marketplace_published_establishments
       (establishment_id, source_site, slug, publication_version, status, event_key, snapshot, capabilities)
     VALUES ($1::uuid, 'congo.erp.konektag.eu', $2, $3::int, $4, encode(sha256(convert_to($1::text || ':' || $3::text, 'UTF8')), 'hex'), $5::jsonb, $6::text[])`,
    [id, slug, version, status, snap === null ? null : JSON.stringify(snap), caps]);

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query('DROP SCHEMA IF EXISTS konektag CASCADE; CREATE SCHEMA konektag');
    const sql = readFileSync(MIGRATION, 'utf8');
    await owner.query(sql);
    await owner.query(sql); // re-applying the migration is a no-op
    // The API identity: SELECT on the projection only.
    await owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marketplace_reader_test') THEN CREATE ROLE marketplace_reader_test LOGIN; END IF; END $$`);
    await owner.query('GRANT USAGE ON SCHEMA konektag TO marketplace_reader_test');
    await owner.query('GRANT SELECT ON konektag.marketplace_published_establishments TO marketplace_reader_test');
    const readerUrl = new URL(url!); readerUrl.username = 'marketplace_reader_test'; readerUrl.password = '';
    reader = new pg.Pool({ connectionString: readerUrl.href });
    await insert('11111111-1111-4111-8111-111111111111', 'feane-brazzaville-1111', 'Published', snapshot('feane-brazzaville-1111'), ['restaurant'], 3);
    await insert('22222222-2222-4222-8222-222222222222', 'ancienne-fiche-2222', 'Unpublished', null, []);
    await insert('33333333-3333-4333-8333-333333333333', 'boutique-3333', 'Published', snapshot('boutique-3333'), []);
  });
  afterAll(async () => { await reader?.end(); await owner?.query('DROP SCHEMA IF EXISTS konektag CASCADE'); await owner?.end(); });

  const deps = (): TransactionDeps => ({
    store: () => { throw new Error('no store needed'); },
    site: () => { throw new Error('Lumen must not be called'); },
    publicSite: () => { throw new Error('Lumen must not be called'); },
    profiles: () => sqlPublishedProfiles((text, params) => reader.query(text, params)),
    env: { MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
      'boutique-3333': { restaurant: { site: 'RESTODEMO', posProfile: 'X' } },
      'ancienne-fiche-2222': { restaurant: { site: 'RESTODEMO', posProfile: 'X' } },
    }) },
    now: () => new Date('2026-11-06T10:00:00Z'),
  });
  const get = (slug: string, tail = '') => createContext(new Request(`https://api.test/api/public/marketplace/merchants/${slug}${tail}`), { slug });

  it('serves a published row through the SELECT-only identity', async () => {
    const res = await profileHandler(deps())(get('feane-brazzaville-1111'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      slug: 'feane-brazzaville-1111', establishmentId: '11111111-1111-4111-8111-111111111111', version: 3, name: 'Feane',
      coordinates: { lat: -4.2634, lng: 15.2429 }, capabilities: ['restaurant'],
      logo: { url: 'https://congo.erp.konektag.eu/files/logo.png' },
      media: [{ url: 'https://congo.erp.konektag.eu/files/salle.jpg', alt: 'Salle' }],
      openingHours: [{ day: 2, closed: false, opens: '11:00', closes: '22:30' }],
    });
    expect(body.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers 404 for an unpublished (tombstone) and an absent slug', async () => {
    for (const slug of ['ancienne-fiche-2222', 'jamais-publiee']) {
      const res = await profileHandler(deps())(get(slug));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'PROFILE_NOT_FOUND' });
    }
  });

  it('never reaches Lumen without a published restaurant capability', async () => {
    const order = createContext(new Request('https://api.test/x', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'web-0123456789abcdef' },
      body: JSON.stringify({ currency: 'XAF', lines: [{ itemCode: 'A', quantity: 1, unitPrice: 1 }], customer: { name: 'Test', phone: '+242060000000' } }) }), { slug: 'boutique-3333' });
    // Published without capability, and unpublished: both refused before any Frappe call (site() would throw).
    expect((await restaurantHandlers(deps()).order(order)).status).toBe(404);
    expect((await catalogueHandlers(deps()).menu(get('boutique-3333', '/restaurant/menu'))).status).toBe(404);
    expect((await catalogueHandlers(deps()).menu(get('ancienne-fiche-2222', '/restaurant/menu'))).status).toBe(404);
  });

  it('keeps the reader read-only', async () => {
    await expect(reader.query(`UPDATE konektag.marketplace_published_establishments SET status = 'Unpublished'`)).rejects.toThrow(/permission denied/);
  });

  it('enforces the projection invariants in the schema', async () => {
    const bad = [
      ['44444444-4444-4444-8444-444444444441', 'tombstone-avec-snapshot', 'Unpublished', snapshot('x'), []],
      ['44444444-4444-4444-8444-444444444442', 'publiee-sans-snapshot', 'Published', null, []],
      ['44444444-4444-4444-8444-444444444443', 'capacite-inconnue', 'Published', snapshot('x'), ['spa']],
      ['44444444-4444-4444-8444-444444444444', 'Slug_Invalide', 'Published', snapshot('x'), []],
      ['44444444-4444-4444-8444-444444444445', 'feane-brazzaville-1111', 'Published', snapshot('x'), []],
    ] as const;
    const codes: string[] = [];
    for (const [id, slug, status, snap, caps] of bad)
      codes.push(await insert(id, slug, status, snap, [...caps]).then(() => 'accepted', (e: any) => e.code));
    // 23514 check_violation for the four invariants, 23505 unique_violation for the reused slug.
    expect(codes).toEqual(['23514', '23514', '23514', '23514', '23505']);
  });

  it('reports an unreachable projection as unavailable, not as missing', async () => {
    const broken = new pg.Pool({ connectionString: url!.replace('/konektag_test', '/base_absente'), connectionTimeoutMillis: 2000 });
    const profiles = sqlPublishedProfiles((text, params) => broken.query(text, params));
    await expect(profiles.bySlug('feane-brazzaville-1111')).rejects.toBeInstanceOf(ProjectionUnavailable);
    const res = await profileHandler({ ...deps(), profiles: () => profiles })(get('feane-brazzaville-1111'));
    expect(res.status).toBe(503);
    await broken.end();
  });

  describe('published listing and facets (Web #52)', () => {
    const fixtures = Array.from({length:57}, (_,i) => ({
      slug: `fixture-${String(i).padStart(3,'0')}`,
      name: ['École', 'eclair', 'Àlpha', 'zèbre'][i%4] + ` ${String(57-i).padStart(3,'0')}`,
      city: i%2 ? 'fr-saint-pierre-a' : 'fr-saint-pierre-b',
      lat: i%4 === 0 ? null : 40+i/10,
      lng: i%4 === 0 ? null : 2,
      activity: i%3 ? 'cafe' : 'restaurant',
    }));
    const readerService = () => publishedMarketplace((sql,params)=>reader.query(sql,params));
    const request = (q='') => createContext(new Request(`https://api.test/api/public/marketplace/merchants?${q}`));
    const list = async (q='') => {
      const response = await listGET(request(q),readerService());
      expect(response.status).toBe(200);
      return response.json();
    };
    beforeAll(async () => {
      for (const [i,f] of fixtures.entries()) await insert(
        `55555555-5555-4555-8555-${String(i).padStart(12,'0')}`, f.slug, 'Published', {
          ...snapshot(f.slug), establishment_name:f.name, country_code:'FR', city_id:f.city, city_name:'Saint-Pierre',
          latitude:f.lat, longitude:f.lng, description:'Pâtisserie et spécialités locales',
          merchant:{...snapshot(f.slug).merchant, seo_description:'Cuisine de saison'},
          activities:[{activity_code:f.activity,activity_name:f.activity==='cafe'?'Café':'Restaurant'}],
        }, []);
      // Missing longitude must not be coerced to zero, in list or public profile.
      await owner.query(`UPDATE konektag.marketplace_published_establishments SET snapshot=jsonb_set(snapshot,'{longitude}','null') WHERE slug='fixture-001'`);
      fixtures[1].lng = null;
      const profile=await (await profileHandler(deps())(get('fixture-001'))).json();
      expect(profile.coordinates).toBeUndefined();
    });
    it('breaks identical name and distance ties by the public slug', async () => {
      for (const sort of ['name','distance']) {
        const body=await list(`country=CG&sort=${sort}&lat=-4.2634&lng=15.2429&limit=1`);
        expect(body.items[0].slug).toBe('boutique-3333');
        expect((await list(`country=CG&sort=${sort}&lat=-4.2634&lng=15.2429&limit=1&page=2`)).items[0].slug).toBe('feane-brazzaville-1111');
      }
    });
    it('sorts the complete result before paginating three pages, with stable slugs and total on empty pages', async () => {
      const fold = (s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const expected = [...fixtures].sort((a,b)=>fold(a.name)<fold(b.name)?-1:fold(a.name)>fold(b.name)?1:a.slug.localeCompare(b.slug));
      const all = [];
      for (let page=1;page<=3;page++) {
        const body = await list(`country=FR&page=${page}`);
        expect(body).toMatchObject({total:57,page,limit:24,sort:'name'});
        all.push(...body.items);
      }
      expect(all.map(f=>f.slug)).toEqual(expected.map(f=>f.slug));
      expect(all.every(f=>!('distanceKm' in f))).toBe(true);
      expect(await list('country=FR&page=99')).toMatchObject({items:[],total:57});
      const first = all[0];
      expect((await profileHandler(deps())(get(first.slug))).status).toBe(200);
    });
    it('sorts distance globally across pages and keeps every unlocated establishment at the end', async () => {
      const all = [];
      for (let page=1;page<=3;page++) {
        const body = await list(`country=FR&sort=distance&lat=40&lng=2&page=${page}`);
        expect(body.sort).toBe('distance'); all.push(...body.items);
      }
      expect(all).toHaveLength(57);
      const located = all.filter(f=>f.coordinates);
      const unlocated = all.filter(f=>!f.coordinates);
      expect(located.map(f=>f.slug)).toEqual(fixtures.filter(f=>f.lat!==null&&f.lng!==null).map(f=>f.slug));
      expect(located[0].distanceKm).toBeCloseTo(22.239,2);
      expect(all.slice(located.length)).toEqual(unlocated);
      expect(unlocated).toHaveLength(16);
      expect(unlocated.every(f=>f.distanceKm===null)).toBe(true);
      const named = await list('country=FR&limit=50&page=1');
      const named2 = await list('country=FR&limit=50&page=2');
      expect(unlocated.map(f=>f.slug)).toEqual([...named.items,...named2.items].filter(f=>!f.coordinates).map(f=>f.slug));
    });
    it('combines free text, country, city id and activity before pagination; accents and case are ignored', async () => {
      const body = await list('q=PÂTISSERIE&country=FR&city=fr-saint-pierre-a&activity=cafe&limit=2');
      const expected = fixtures.filter(f=>f.city==='fr-saint-pierre-a'&&f.activity==='cafe');
      expect(body.total).toBe(expected.length);
      expect(body.items).toHaveLength(2);
      expect(body.items.every((f:any)=>f.city.id==='fr-saint-pierre-a'&&f.activities[0].code==='cafe')).toBe(true);
      expect((await list('q=ECOLE&country=FR')).total).toBe(15);
      expect((await list('q=CAFE&country=FR')).total).toBe(38);
      expect((await list('country=CG&city=fr-saint-pierre-a')).total).toBe(0);
      expect((await list('q=%27%20OR%201%3D1--')).total).toBe(0);
    });
    it('counts published facets and distinguishes homonymous cities by id', async () => {
      const response = await facetsGET(request(),readerService());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.countries).toEqual([
        {code:'CG',count:2,cities:[{id:'cg-bzv',name:'Brazzaville',count:2}]},
        {code:'FR',count:57,cities:[{id:'fr-saint-pierre-a',name:'Saint-Pierre',count:28},{id:'fr-saint-pierre-b',name:'Saint-Pierre',count:29}]},
      ]);
      expect(body.activities).toEqual([{code:'cafe',name:'Café',count:38},{code:'restaurant',name:'Restaurant',count:21}]);
      const all = await list('limit=50');
      expect(all.total).toBe(59);
      expect(all.items.some((f:any)=>f.slug==='ancienne-fiche-2222')).toBe(false);
    });
    it('validates bounds and distance coordinates, and reports database errors as 503', async () => {
      for (const q of ['sort=other','sort=distance','sort=distance&lat=0','lat=91','lng=181','lat=','page=0','page=1.2','limit=51','limit=','country=ZZ','city=','q='+ 'a'.repeat(121)]) {
        expect((await listGET(request(q),readerService())).status, q).toBe(422);
      }
      const broken = publishedMarketplace(async()=>{throw new Error('offline');});
      for (const handler of [listGET,facetsGET]) {
        const res = await handler(request(),broken);
        expect(res.status).toBe(503); expect(await res.json()).toEqual({error:'PROJECTION_UNAVAILABLE'});
      }
    });
    it('immediately removes an unpublished row from listing and facets', async () => {
      const f=fixtures[0];
      await owner.query(`UPDATE konektag.marketplace_published_establishments SET status='Unpublished',snapshot=NULL WHERE slug=$1`,[f.slug]);
      expect((await list('country=FR')).total).toBe(56);
      const body = await (await facetsGET(request(),readerService())).json();
      expect(body.countries.find((c:any)=>c.code==='FR').count).toBe(56);
      expect(body.activities.find((a:any)=>a.code==='restaurant').count).toBe(20);
      expect((await profileHandler(deps())(get(f.slug))).status).toBe(404);
    });
  });

});
