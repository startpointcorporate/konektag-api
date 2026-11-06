// Marketplace read (API #24) against a real, isolated PostgreSQL.
// Runs only when MARKETPLACE_PG_TEST_URL points at a throwaway database named
// konektag_test (owner rights to apply migration 228). Never production.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { profileHandler, restaurantHandlers, catalogueHandlers, type TransactionDeps } from '../../src/application/marketplace-transactions/http-handlers.ts';
import { ProjectionUnavailable, sqlPublishedProfiles } from '../../src/application/marketplace-transactions/published-profiles.ts';

const url = process.env.MARKETPLACE_PG_TEST_URL;
const isolated = !!url && new URL(url).pathname === '/konektag_test';
const MIGRATION = 'src/lib/infrastructure/database/migrations/228_marketplace_published_establishments.sql';

describe.skipIf(!isolated)('Marketplace projection on PostgreSQL (migration 228)', () => {
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
});
