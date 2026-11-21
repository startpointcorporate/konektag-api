/**
 * Public catalogue (KON-108): ERPNext Item, Item Price and File read through the real
 * Frappe transport against one fake Frappe per host. Fixtures follow the catalogues
 * initialised on 2026-11-19 (rocherdesages: docs/reports/INITIALISATION_CATALOGUES_2026-11-19.md):
 * 14 sellable RDA services on both sites, XAF rates on ABM Demo only, none on the client site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http.ts';
import { GET as listRoute } from '../../src/api/routes/public/catalog/items/index.ts';
import { GET as detailRoute } from '../../src/api/routes/public/catalog/items/[ref].ts';
import { defaultCatalogDeps, type CatalogDeps } from '../../src/application/public-website/catalog-http.ts';
import { CatalogConfigError, loadCatalogSites } from '../../src/application/public-website/catalog-config.ts';
import { clearCatalogCache, itemSlug, plainText } from '../../src/application/public-website/catalog-service.ts';
import { itemMedia, publicMediaUrl } from '../../src/application/public-website/media.ts';

// ── fixtures ─────────────────────────────────────────────────────────────

const GROUPS = ['Location de salles', 'Location de bureaux', 'Publicité sur écrans', 'Location de matériel événementiel'];
// [code suffix, label, uom, group, ABM Demo rate] — scripts/catalog/catalog.py of rocherdesages.
const SERVICES: [string, string, string, number, number][] = [
  ['EPHRAIM', 'Location Salle Ephraim', 'Hour', 0, 35000], ['LOLIMAK', 'Location Salle Lolimak', 'Day', 0, 180000],
  ['LIZINGA', 'Location Salle Li-Zinga', 'Day', 0, 300000], ['BUREAU-J', 'Bureau équipé — journée', 'Day', 1, 25000],
  ['BUREAU-M', 'Bureau équipé — mois', 'Mois', 1, 300000], ['BUREAU-A', 'Bureau équipé — année', 'Année', 1, 3000000],
  ['ECRAN-M', 'Publicité écran géant — mois', 'Mois', 2, 150000], ['ECRAN-A', 'Publicité écran géant — année', 'Année', 2, 1500000],
  ['CHAISE', 'Location chaise de cérémonie', 'Unit', 3, 1000], ['INSTRUMENT', 'Location instrument de musique', 'Unit', 3, 25000],
  ['PISTE', 'Location piste lumineuse', 'Square Meter', 3, 8000], ['LUMIERES', 'Location jeux de lumières', 'Forfait', 3, 50000],
  ['FUMIGENE', 'Prestation diffuseur de fumée', 'Forfait', 3, 30000], ['SONO', 'Location sonorisation événementielle', 'Forfait', 3, 100000],
];
const code = (suffix: string, group: number) => (group === 2 ? 'RDA-PUB-' : 'RDA-LOC-') + suffix;
const SECRET_FIELDS = { valuation_rate: 12345, last_purchase_rate: 999, item_defaults: [{ company: 'RDA', income_account: '7061-Dans la Région' }], owner: 'admin@rocherdesages.net' };

function rdaItems(abbr: string) {
  const items: any[] = SERVICES.map(([suffix, label, uom, group]) => ({
    name: code(suffix, group), item_name: label, item_group: GROUPS[group], stock_uom: uom, sales_uom: null, brand: null,
    description: label, image: null, variant_of: null, has_variants: 0, disabled: 0, is_sales_item: 1, ...SECRET_FIELDS,
  }));
  // Internal reference sheets of the spaces: not sellable, never public.
  for (const [name, label] of [['RDA-SAL-EPHRAIM', 'Salle Ephraim'], ['RDA-SAL-LOLIMAK', 'Salle Lolimak'], ['RDA-SAL-LIZINGA', 'Salle Li-Zinga'], ['RDA-BUR-EQUIPE', 'Bureaux équipés']])
    items.push({ name, item_name: label, item_group: GROUPS[0], stock_uom: 'Unit', description: label, has_variants: 0, disabled: 0, is_sales_item: 0, ...SECRET_FIELDS });
  if (abbr === 'ABMD') {
    items.push({ name: 'ABMD-TEST-SONO', item_name: '[FICTIF ABM Demo] Système de sonorisation', item_group: 'Équipements fictifs ABM Demo', stock_uom: 'Unit', has_variants: 0, disabled: 0, is_sales_item: 0 });
    items.push({ name: 'RDA-LOC-ANCIEN', item_name: 'Ancienne prestation', item_group: GROUPS[3], stock_uom: 'Unit', has_variants: 0, disabled: 1, is_sales_item: 1 });
  }
  return items;
}

const TODAY = '2026-11-21';
const abmPrices = () => [
  ...SERVICES.map(([suffix, , uom, group, rate], i) => ({ name: `price-${i}`, item_code: code(suffix, group), price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: rate, currency: 'XAF', uom, selling: 1, valid_from: '2026-11-19', valid_upto: null, customer: null, batch_no: null })),
  // Negotiated, batch, expired and future rates of the same Item.
  { name: 'p-cust', item_code: 'RDA-LOC-EPHRAIM', price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: 1, currency: 'XAF', uom: 'Hour', selling: 1, customer: '[FICTIF ABM Demo] Client recette catalogue' },
  { name: 'p-batch', item_code: 'RDA-LOC-EPHRAIM', price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: 2, currency: 'XAF', uom: 'Hour', selling: 1, batch_no: 'B1' },
  { name: 'p-old', item_code: 'RDA-LOC-EPHRAIM', price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: 3, currency: 'XAF', uom: 'Hour', selling: 1, valid_upto: '2026-10-31' },
  { name: 'p-2027', item_code: 'RDA-LOC-EPHRAIM', price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: 40000, currency: 'XAF', uom: 'Hour', selling: 1, valid_from: '2027-01-01' },
  { name: 'p-eur', item_code: 'RDA-LOC-SONO', price_list: 'ABM Demo — Tarifs export', price_list_rate: 150, currency: 'EUR', uom: 'Forfait', selling: 1 },
  { name: 'p-zero', item_code: 'RDA-LOC-CHAISE', price_list: 'Standard Selling', price_list_rate: 0, currency: 'XAF', uom: 'Unit', selling: 1 },
  { name: 'p-buy', item_code: 'RDA-LOC-CHAISE', price_list: 'ABM Demo — Tarifs de démonstration', price_list_rate: 400, currency: 'XAF', uom: 'Unit', selling: 0 },
];
const abmFiles = () => [
  { name: 'f-cover', file_url: '/files/ephraim-salle.jpg', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:00:00' },
  { name: 'f-video', file_url: 'https://www.youtube.com/watch?v=abc123', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:01:00' },
  { name: 'f-tour', file_url: 'https://my.matterport.com/show/?m=xyz', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:02:00' },
  { name: 'f-clip', file_url: '/files/ephraim-visite.mp4', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:03:00' },
  { name: 'f-pdf', file_url: '/files/contrat-type.pdf', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:04:00' },
  { name: 'f-private', file_url: '/private/files/devis-client.jpg', is_private: 1, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:05:00' },
  { name: 'f-lie', file_url: '/private/files/plan-securite.png', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:06:00' },
  { name: 'f-http', file_url: 'http://insecure.example.com/photo.jpg', is_private: 0, attached_to_doctype: 'Item', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:07:00' },
  { name: 'f-other', file_url: '/files/facture.jpg', is_private: 0, attached_to_doctype: 'Sales Invoice', attached_to_name: 'RDA-LOC-EPHRAIM', creation: '2026-11-19 10:08:00' },
];

interface FakeFrappe { docs: Record<string, any[]>; down?: boolean; calls: { doctype: string; auth: string | null }[] }
let sites: Record<string, FakeFrappe>;

function matches(doc: any, [field, op, value]: [string, string, unknown]) {
  const v = doc[field] ?? (['disabled', 'has_variants', 'is_private'].includes(field) ? 0 : null);
  if (op === '=') return v === value;
  if (op === 'in') return (value as unknown[]).includes(v);
  throw new Error('unsupported filter ' + op);
}

/** Answers /api/resource like Frappe: filters, field projection, 404 for an unknown DocType. */
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const site = sites[url.hostname];
  if (!site || site.down) throw new TypeError('fetch failed');
  const [, , , doctype, name] = url.pathname.split('/').map(decodeURIComponent);
  site.calls.push({ doctype, auth: new Headers(init?.headers).get('authorization') });
  const rows = site.docs[doctype];
  if (!rows) return Response.json({ exc_type: 'DoesNotExistError', exception: `DocType ${doctype} not found on ${url.hostname}` }, { status: 404 });
  if (name) {
    const doc = rows.find(r => r.name === name);
    return doc ? Response.json({ data: doc }) : Response.json({ exc_type: 'DoesNotExistError' }, { status: 404 });
  }
  const filters = JSON.parse(url.searchParams.get('filters') ?? '[]');
  const fields: string[] = JSON.parse(url.searchParams.get('fields') ?? '["name"]');
  const limit = Number(url.searchParams.get('limit_page_length'));
  const data = rows.filter(r => filters.every((f: any) => matches(r, f))).slice(0, limit)
    .map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? null])));
  return Response.json({ data });
}) as typeof fetch;

const rules: Record<string, string> = { BE: 'FR', CG: 'CG', CM: 'CG', LB: 'LB' };
const database = { query: vi.fn(async (_sql: string, values?: unknown[]) => ({ rows: rules[String(values?.[0])] ? [{ payment_country: rules[String(values?.[0])] }] : [] })) };

const env = {
  MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
    'konektag-cg': { site: 'KONEKTAG_CG' }, 'konektag-fr': { site: 'EUROPE' },
    'rocher-des-ages': { site: 'ROCHERDESAGES' }, 'abm-demo': { site: 'ABMDEMO' }, 'sans-catalogue': { site: 'NOCATALOG' },
  }),
  ...Object.fromEntries([['ROCHERDESAGES', 'rocherdesages.erp.konektag.eu'], ['ABMDEMO', 'abmdemo.erp.konektag.eu'], ['KONEKTAG_CG', 'congo.erp.konektag.eu'], ['NOCATALOG', 'nocatalog.erp.konektag.eu'], ['EUROPE', 'europe.erp.konektag.eu']]
    .flatMap(([key, host]) => [[`MARKETPLACE_FRAPPE_${key}_URL`, `https://${host}/`], [`MARKETPLACE_FRAPPE_${key}_API_KEY`, `key-${key}`], [`MARKETPLACE_FRAPPE_${key}_API_SECRET`, `secret-${key}`]])),
  PUBLIC_CATALOG_SITES: JSON.stringify({
    'rocher-des-ages': { priceLists: ['Rocher des Âges — Tarifs commerciaux'], abmResources: true },
    'abm-demo': { priceLists: ['ABM Demo — Tarifs de démonstration', 'ABM Demo — Tarifs export'], abmResources: true, characteristicFields: [{ field: 'custom_capacite', label: 'Capacité' }] },
    'konektag-cg': { priceLists: ['Konektag CG — Tarifs publics'], itemGroups: ['Services Konektag'], publishedField: 'custom_public_website' },
  }),
} as NodeJS.ProcessEnv;

let deps: CatalogDeps;
let now: Date;

beforeEach(() => {
  clearCatalogCache();
  now = new Date(`${TODAY}T09:00:00Z`);
  const abmItems = rdaItems('ABMD').map(item => item.name === 'RDA-LOC-EPHRAIM' ? { ...item, image: '/files/ephraim-salle.jpg', custom_capacite: 120, description: '<p>Salle de <b>120 places</b>&nbsp;climatisée.</p><script>alert(1)</script>' } : item);
  sites = {
    'rocherdesages.erp.konektag.eu': { calls: [], docs: {
      Item: rdaItems('RDA'), 'Item Price': [], File: [],
      // No ERPNext price exists: the price list is empty, and ERPNext would propose 0.00.
    } },
    'abmdemo.erp.konektag.eu': { calls: [], docs: {
      Item: abmItems, 'Item Price': abmPrices(), File: abmFiles(),
      'ABM Resource': [
        { name: 'SALLE-EPHRAIM', resource_name: 'Salle Ephraim', resource_type: 'Space', capacity: 120, selling_item: 'RDA-LOC-EPHRAIM', enabled: 1 },
        { name: 'SALLE-ARCHIVE', resource_name: 'Ancienne salle', resource_type: 'Space', capacity: 10, selling_item: 'RDA-LOC-LOLIMAK', enabled: 0 },
      ],
      'ABM Equipment Pool': [{ name: 'POOL-SONO', item: 'RDA-LOC-SONO', available_quantity: 1, enabled: 1 }],
    } },
    'congo.erp.konektag.eu': { calls: [], docs: {
      Item: [
        { name: 'KTG-PACK-360', item_name: 'Pack Konektag 360', item_group: 'Services Konektag', stock_uom: 'Mois', has_variants: 0, disabled: 0, is_sales_item: 1, custom_public_website: 1 },
        { name: 'KTG-INTERNE', item_name: 'Prestation interne', item_group: 'Services Konektag', stock_uom: 'Unit', has_variants: 0, disabled: 0, is_sales_item: 1, custom_public_website: 0 },
        { name: 'KTG-AUTRE', item_name: 'Hors catalogue', item_group: 'Divers', stock_uom: 'Unit', has_variants: 0, disabled: 0, is_sales_item: 1, custom_public_website: 1 },
      ],
      'Item Price': [{ name: 'k1', item_code: 'KTG-PACK-360', price_list: 'Konektag CG — Tarifs publics', price_list_rate: 50000, currency: 'XAF', uom: 'Mois', selling: 1 }],
      File: [],
    } },
    'nocatalog.erp.konektag.eu': { calls: [], docs: { Item: rdaItems('RDA') } },
  };
  database.query.mockClear();
  deps = { ...defaultCatalogDeps(env, { fetchImpl, database }), now: () => now };
});
afterEach(() => vi.restoreAllMocks());

const list = (query: string, headers: Record<string, string> = {}) =>
  listRoute(createContext(new Request(`https://api.konektag.eu/api/public/catalog/items?${query}`, { headers })), deps);
const detail = (ref: string, query: string, headers: Record<string, string> = {}) =>
  detailRoute(createContext(new Request(`https://api.konektag.eu/api/public/catalog/items/${encodeURIComponent(ref)}?${query}`, { headers }), { ref }), deps);

// ── tests ────────────────────────────────────────────────────────────────

describe('public catalogue — Rocher des Âges (client site, no real XAF rates loaded)', () => {
  it('lists the 14 sellable services, each explicitly NOT_PRICED, never at zero', async () => {
    const response = await list('site=rocher-des-ages&limit=50');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.site).toEqual({ id: 'rocher-des-ages', kind: 'CUSTOMER' });
    expect(body.total).toBe(14);
    expect(body.items.map((i: any) => i.id).sort()).toEqual(SERVICES.map(([s, , , g]) => code(s, g)).sort());
    for (const item of body.items) {
      expect(item.price).toEqual({ status: 'NOT_PRICED', from: null });
      expect(item.cover).toBeNull();
    }
    expect(JSON.stringify(body)).not.toMatch(/"amount":0/);
    expect(body.groups).toEqual([
      { name: 'Location de bureaux', count: 3 }, { name: 'Location de matériel événementiel', count: 6 },
      { name: 'Location de salles', count: 3 }, { name: 'Publicité sur écrans', count: 2 },
    ]);
  });

  it('keeps internal reference sheets and Frappe secrets out of the public response', async () => {
    const response = await list('site=rocher-des-ages&limit=50');
    const raw = await response.text();
    expect(raw).not.toMatch(/RDA-SAL-|RDA-BUR-EQUIPE|valuation|income_account|item_defaults|last_purchase|owner|rocherdesages\.net|secret-|key-ROCHER/);
    expect((await detail('RDA-SAL-EPHRAIM', 'site=rocher-des-ages')).status).toBe(404);
    // The service token is used server-side only.
    expect(sites['rocherdesages.erp.konektag.eu'].calls.every(c => c.auth === 'token key-ROCHERDESAGES:secret-ROCHERDESAGES')).toBe(true);
  });

  it('reports the konektag-abm app as not installed instead of failing the catalogue', async () => {
    const body = await (await detail('rda-loc-ephraim', 'site=rocher-des-ages')).json();
    expect(body.item).toMatchObject({ id: 'RDA-LOC-EPHRAIM', slug: 'rda-loc-ephraim', name: 'Location Salle Ephraim', description: null, prices: [], media: [], resources: { status: 'NOT_INSTALLED', resources: [] } });
    expect(body.item.characteristics).toEqual([{ key: 'unit', label: null, value: 'Hour' }]);
  });
});

describe('public catalogue — ABM Demo (demonstration rates, media, resources)', () => {
  it('serves public Item Prices with list, currency, unit and period; ignores negotiated, batch, expired, buying and zero rates', async () => {
    const body = await (await detail('RDA-LOC-EPHRAIM', 'site=abm-demo')).json();
    expect(body.item.price).toEqual({ status: 'PRICED', from: { priceList: 'ABM Demo — Tarifs de démonstration', currency: 'XAF', amount: 35000, uom: 'Hour', validFrom: '2026-11-19', validUpto: null, current: true } });
    expect(body.item.prices).toEqual([
      { priceList: 'ABM Demo — Tarifs de démonstration', currency: 'XAF', amount: 35000, uom: 'Hour', validFrom: '2026-11-19', validUpto: null, current: true },
      { priceList: 'ABM Demo — Tarifs de démonstration', currency: 'XAF', amount: 40000, uom: 'Hour', validFrom: '2027-01-01', validUpto: null, current: false },
    ]);
    const chairs = await (await detail('rda-loc-chaise', 'site=abm-demo')).json();
    expect(chairs.item.prices.map((p: any) => p.amount)).toEqual([1000]);
  });

  it('filters prices by currency and keeps an explicit absence when none matches', async () => {
    const sono = await (await detail('RDA-LOC-SONO', 'site=abm-demo&currency=EUR')).json();
    expect(sono.item.prices).toEqual([expect.objectContaining({ priceList: 'ABM Demo — Tarifs export', currency: 'EUR', amount: 150 })]);
    const ephraim = await (await detail('RDA-LOC-EPHRAIM', 'site=abm-demo&currency=EUR')).json();
    expect(ephraim.item.price).toEqual({ status: 'NOT_PRICED', from: null });
    const priced = await (await list('site=abm-demo&currency=EUR&priced=true')).json();
    expect(priced.items.map((i: any) => i.id)).toEqual(['RDA-LOC-SONO']);
  });

  it('builds the gallery from public Files: cover photo, video links and files, virtual tour; no private, insecure, foreign or non-media file', async () => {
    const body = await (await detail('RDA-LOC-EPHRAIM', 'site=abm-demo')).json();
    expect(body.item.media).toEqual([
      { id: 'f-cover', kind: 'IMAGE', source: 'FRAPPE_FILE', url: 'https://abmdemo.erp.konektag.eu/files/ephraim-salle.jpg', mimeType: 'image/jpeg', provider: null, isCover: true },
      { id: 'f-video', kind: 'VIDEO', source: 'EXTERNAL_LINK', url: 'https://www.youtube.com/watch?v=abc123', mimeType: null, provider: 'youtube', isCover: false },
      { id: 'f-tour', kind: 'VIRTUAL_TOUR', source: 'EXTERNAL_LINK', url: 'https://my.matterport.com/show/?m=xyz', mimeType: null, provider: 'matterport.com', isCover: false },
      { id: 'f-clip', kind: 'VIDEO', source: 'FRAPPE_FILE', url: 'https://abmdemo.erp.konektag.eu/files/ephraim-visite.mp4', mimeType: 'video/mp4', provider: null, isCover: false },
    ]);
    expect(body.item.mediaCount).toEqual({ images: 1, videos: 2, virtualTours: 1 });
    expect(JSON.stringify(body)).not.toMatch(/private|insecure|facture|contrat-type/);
  });

  it('publishes plain-text descriptions and allowlisted characteristics only', async () => {
    const body = await (await detail('RDA-LOC-EPHRAIM', 'site=abm-demo')).json();
    expect(body.item.description).toBe('Salle de 120 places climatisée.');
    expect(body.item.characteristics).toEqual([{ key: 'unit', label: null, value: 'Hour' }, { key: 'custom_capacite', label: 'Capacité', value: 120 }]);
  });

  it('links Items to enabled konektag-abm resources and equipment pools', async () => {
    const ephraim = await (await detail('RDA-LOC-EPHRAIM', 'site=abm-demo')).json();
    expect(ephraim.item.resources).toEqual({ status: 'AVAILABLE', resources: [{ id: 'SALLE-EPHRAIM', name: 'Salle Ephraim', type: 'SPACE', capacity: 120 }] });
    const sono = await (await detail('RDA-LOC-SONO', 'site=abm-demo')).json();
    expect(sono.item.resources.resources).toEqual([{ id: 'POOL-SONO', name: 'POOL-SONO', type: 'EQUIPMENT', capacity: null }]);
    const lolimak = await (await detail('RDA-LOC-LOLIMAK', 'site=abm-demo')).json();
    expect(lolimak.item.resources).toEqual({ status: 'AVAILABLE', resources: [] });
    expect(JSON.stringify(ephraim)).not.toMatch(/available_quantity/);
  });

  it('excludes disabled, non-sellable and demonstration stock Items', async () => {
    const body = await (await list('site=abm-demo&limit=50')).json();
    expect(body.total).toBe(14);
    expect(body.items.map((i: any) => i.id)).not.toContain('RDA-LOC-ANCIEN');
    expect(body.items.map((i: any) => i.id)).not.toContain('ABMD-TEST-SONO');
  });

  it('filters by group, accent-insensitive text and price presence', async () => {
    const screens = await (await list('site=abm-demo&group=' + encodeURIComponent('Publicité sur écrans'))).json();
    expect(screens.items.map((i: any) => i.id)).toEqual(['RDA-PUB-ECRAN-A', 'RDA-PUB-ECRAN-M']);
    const text = await (await list('site=abm-demo&q=equipe')).json();
    expect(text.items.map((i: any) => i.name)).toEqual(['Bureau équipé — année', 'Bureau équipé — journée', 'Bureau équipé — mois']);
    const unpriced = await (await list('site=abm-demo&priced=false')).json();
    expect(unpriced.total).toBe(0);
  });

  it('paginates with opaque cursors and rejects forged ones', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await (await list('site=abm-demo&limit=5' + (cursor ? `&cursor=${cursor}` : ''))).json();
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((i: any) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    for (const forged of ['bm90LWpzb24', Buffer.from('{"o":-1}').toString('base64url'), Buffer.from('{"o":99999}').toString('base64url')]) {
      const response = await list('site=abm-demo&cursor=' + forged);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'INVALID_PARAMETERS' });
    }
    expect((await list('site=abm-demo&limit=500')).status).toBe(422);
  });

  it('answers 304 to a matching If-None-Match and serves the cached snapshot for 60 s', async () => {
    const first = await list('site=abm-demo');
    const tag = first.headers.get('etag')!;
    expect(first.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=120');
    const calls = sites['abmdemo.erp.konektag.eu'].calls.length;
    const second = await list('site=abm-demo', { 'If-None-Match': `W/${tag}` });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(sites['abmdemo.erp.konektag.eu'].calls.length).toBe(calls);
    now = new Date(now.getTime() + 61_000);
    sites['abmdemo.erp.konektag.eu'].docs['Item Price'][0].price_list_rate = 36000;
    const third = await list('site=abm-demo', { 'If-None-Match': tag });
    expect(third.status).toBe(200);
    expect(third.headers.get('etag')).not.toBe(tag);
  });
});

describe('public catalogue — site routing and Konektag sites', () => {
  it('routes a residence country to its Konektag site and applies its publication rules', async () => {
    const response = await list('country=CM');
    const body = await response.json();
    expect(body.site).toEqual({ id: 'konektag-cg', kind: 'KONEKTAG' });
    expect(body.items).toEqual([expect.objectContaining({ id: 'KTG-PACK-360', price: { status: 'PRICED', from: expect.objectContaining({ amount: 50000, currency: 'XAF' }) } })]);
    expect(sites['rocherdesages.erp.konektag.eu'].calls).toHaveLength(0);
  });

  it('requires exactly one of site and country', async () => {
    expect(await (await list('')).json()).toEqual({ error: 'SITE_REQUIRED' });
    const both = await list('site=rocher-des-ages&country=CG');
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({ error: 'SITE_AND_COUNTRY_EXCLUSIVE' });
    expect((await list('site=Rocher_Des_Ages')).status).toBe(400);
  });

  it('does not distinguish unknown, unrouted and unpublished sites', async () => {
    for (const site of ['inconnu', 'sans-catalogue', 'konektag-lb']) {
      const response = await list('site=' + site);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'SITE_NOT_FOUND' });
    }
    // A routed country whose site does not publish a catalogue.
    expect(await (await list('country=BE')).json()).toEqual({ error: 'SITE_NOT_FOUND' });
    expect(sites['nocatalog.erp.konektag.eu'].calls).toHaveLength(0);
  });

  it('maps country routing errors without leaking configuration', async () => {
    expect((await list('country=XX')).status).toBe(422);
    expect(await (await list('country=XX')).json()).toEqual({ error: 'COUNTRY_RULE_NOT_FOUND' });
    expect(await (await list('country=1')).json()).toEqual({ error: 'RESIDENCE_COUNTRY_INVALID' });
  });

  it('answers 503 without Frappe details when the site is down, and retries next time', async () => {
    sites['abmdemo.erp.konektag.eu'].down = true;
    const down = await list('site=abm-demo');
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    expect(await down.json()).toEqual({ error: 'CATALOG_UNAVAILABLE' });
    sites['abmdemo.erp.konektag.eu'].down = false;
    expect((await list('site=abm-demo')).status).toBe(200);
  });

  it('returns 404 for an unknown item and resolves an item by code or slug', async () => {
    expect(await (await detail('RDA-LOC-INCONNU', 'site=abm-demo')).json()).toEqual({ error: 'ITEM_NOT_FOUND' });
    const byCode = await (await detail('RDA-PUB-ECRAN-M', 'site=abm-demo')).json();
    const bySlug = await (await detail('rda-pub-ecran-m', 'site=abm-demo')).json();
    expect(bySlug).toEqual(byCode);
  });

  it('shows variant attributes on the variant sheet', async () => {
    sites['abmdemo.erp.konektag.eu'].docs.Item.push({ name: 'RDA-LOC-NAPPE-BLANCHE', item_name: 'Nappe blanche', item_group: GROUPS[3], stock_uom: 'Unit', variant_of: 'RDA-LOC-NAPPE', has_variants: 0, disabled: 0, is_sales_item: 1,
      attributes: [{ attribute: 'Couleur', attribute_value: 'Blanc' }] });
    const body = await (await detail('rda-loc-nappe-blanche', 'site=abm-demo')).json();
    expect(body.item.variantOf).toBe('RDA-LOC-NAPPE');
    expect(body.item.characteristics).toContainEqual({ key: 'attribute:Couleur', label: 'Couleur', value: 'Blanc' });
  });
});

describe('public catalogue — building blocks', () => {
  it('rejects configuration that would publish internal Item fields', () => {
    expect(() => loadCatalogSites({ PUBLIC_CATALOG_SITES: JSON.stringify({ x: { priceLists: ['P'], characteristicFields: [{ field: 'valuation_rate', label: 'V' }] } }) })).toThrow(CatalogConfigError);
    expect(() => loadCatalogSites({ PUBLIC_CATALOG_SITES: JSON.stringify({ x: { priceLists: [] } }) })).toThrow(CatalogConfigError);
    expect(() => loadCatalogSites({ PUBLIC_CATALOG_SITES: '{' })).toThrow(CatalogConfigError);
    expect(loadCatalogSites({})).toEqual({});
  });

  it('accepts only public file paths and https links', () => {
    const host = 'rocherdesages.erp.konektag.eu';
    expect(publicMediaUrl('/files/salle.jpg', host)?.url.href).toBe('https://rocherdesages.erp.konektag.eu/files/salle.jpg');
    for (const bad of ['/private/files/a.jpg', '/files/../private/files/a.jpg', '/api/method/frappe.utils.file_manager.download_file?file_url=/private/files/a.jpg',
      `https://${host}/private/files/a.jpg`, 'http://example.com/a.jpg', 'https://user:pw@example.com/a.jpg', 'javascript:alert(1)', 'files/a.jpg'])
      expect(publicMediaUrl(bad, host)).toBeNull();
    // A private Item.image never becomes the cover.
    expect(itemMedia('/private/files/cover.jpg', [], host)).toEqual([]);
    // Configured tour hosts extend the built-in providers.
    expect(itemMedia(null, [{ name: 'f', file_url: 'https://tour.example.org/rda', is_private: 0, attached_to_name: 'X' }], host, ['tour.example.org'])[0])
      .toMatchObject({ kind: 'VIRTUAL_TOUR', provider: 'tour.example.org', isCover: false });
  });

  it('derives stable slugs and plain text', () => {
    expect(itemSlug('RDA-LOC-ÉCRAN Géant')).toBe('rda-loc-ecran-geant');
    expect(plainText('<p>A &amp; B</p><p>C</p>')).toBe('A & B\nC');
    expect(plainText('<style>x{}</style>')).toBeNull();
  });
});
