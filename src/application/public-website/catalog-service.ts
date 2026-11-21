/**
 * Public catalogue of a Frappe site, read live from native ERPNext documents:
 *   Item        sellable (is_sales_item), enabled, not a variant template, optionally
 *               restricted to Item Groups and to a publication Check field (catalog-config.ts);
 *   Item Price  selling rates of the configured public Price Lists, without customer or batch;
 *   File        public files and external links attached to the Item (media.ts);
 *   ABM         konektag-abm resources selling the Item, when the site enables them.
 *
 * The projection is an allowlist: accounts, valuation, purchase, stock, owner and any
 * field not named here never reach the browser. A missing or non-positive rate is an
 * explicit NOT_PRICED: ERPNext proposes 0.00 when no price exists, so 0 means "unknown".
 * Prices are Price List rates; taxes stay computed by ERPNext on the quotation.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FrappeSiteError, type Filter, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import type { CatalogSiteConfig } from './catalog-config.ts';
import { itemMedia, type FileRow, type MediaAsset } from './media.ts';
import type { PublicSiteContext } from './site-context.ts';

/** Upper bound of a public catalogue; a larger one is served truncated and logged. */
export const MAX_ITEMS = 1000;
export const CACHE_TTL_MS = 60_000;

export const catalogListQuery = z.object({
  group: z.string().trim().min(1).max(140).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  priced: z.enum(['true', 'false']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().min(1).max(200).optional(),
});
export type CatalogListQuery = z.infer<typeof catalogListQuery>;
export const catalogDetailQuery = z.object({ currency: z.string().regex(/^[A-Z]{3}$/).optional() });

export class InvalidCursor extends Error {}

export interface PublicPrice {
  priceList: string;
  currency: string;
  amount: number;
  uom: string | null;
  validFrom: string | null;
  validUpto: string | null;
  current: boolean;
}
export type PriceSummary = { status: 'PRICED'; from: PublicPrice } | { status: 'NOT_PRICED'; from: null };
export interface Characteristic { key: string; label: string | null; value: string | number | boolean }
export type AbmLinks =
  | { status: 'AVAILABLE'; resources: { id: string; name: string; type: 'SPACE' | 'EQUIPMENT'; capacity: number | null }[] }
  | { status: 'NOT_CONFIGURED' | 'NOT_INSTALLED' | 'UNAVAILABLE'; resources: [] };

export interface Entry {
  id: string;
  slug: string;
  name: string;
  group: string | null;
  description: string | null;
  variantOf: string | null;
  uom: string | null;
  characteristics: Characteristic[];
  prices: PublicPrice[];
  media: MediaAsset[];
  resources: AbmLinks;
}
export interface Snapshot {
  site: PublicSiteContext;
  priceLists: string[];
  entries: Entry[];
  /** Variant attributes read on demand, cached with the snapshot. */
  attributes: Map<string, Promise<Characteristic[]>>;
}

const SNAPSHOTS = new Map<string, { at: number; value: Promise<Snapshot> }>();
export const clearCatalogCache = () => SNAPSHOTS.clear();

// ── projection helpers ────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const codePoint = (value: number) => Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
/** Plain text of an ERPNext Text Editor value: no markup reaches the browser. */
export function plainText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (_, named, dec, hex) =>
      named ? ENTITIES[named.toLowerCase()] : codePoint(dec ? Number(dec) : parseInt(hex, 16)))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 6);
export function itemSlug(itemCode: string): string {
  const slug = itemCode.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140);
  return slug || 'item-' + shortHash(itemCode);
}

const INTERNAL_HOST = /(^|\.)(svc\.cluster\.local|localhost)$|^127\.0\.0\.1$/;
/** Calendar date of `now` in a time zone, as YYYY-MM-DD. */
const localDate = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

function publicPrices(rows: any[], priceLists: string[], today: string): Map<string, PublicPrice[]> {
  const byItem = new Map<string, PublicPrice[]>();
  for (const row of rows) {
    const amount = Number(row.price_list_rate);
    const validFrom = date(row.valid_from);
    const validUpto = date(row.valid_upto);
    // Customer-specific and batch prices are negotiated, not public; expired ones are history.
    if (!priceLists.includes(row.price_list) || text(row.customer) || text(row.batch_no)) continue;
    if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(String(row.currency ?? ''))) continue;
    if (validUpto && validUpto < today) continue;
    const price: PublicPrice = {
      priceList: row.price_list, currency: row.currency, amount, uom: text(row.uom),
      validFrom, validUpto, current: !validFrom || validFrom <= today,
    };
    byItem.set(row.item_code, [...(byItem.get(row.item_code) ?? []), price]);
  }
  for (const prices of byItem.values())
    prices.sort((a, b) => priceLists.indexOf(a.priceList) - priceLists.indexOf(b.priceList)
      || String(a.uom).localeCompare(String(b.uom)) || String(a.validFrom ?? '').localeCompare(String(b.validFrom ?? '')));
  return byItem;
}

function characteristics(item: any, config: CatalogSiteConfig): Characteristic[] {
  const out: Characteristic[] = [];
  const push = (key: string, label: string | null, raw: unknown) => {
    const value = typeof raw === 'number' || typeof raw === 'boolean' ? raw : plainText(raw);
    if (value !== null && value !== '') out.push({ key, label, value });
  };
  push('unit', null, item.sales_uom || item.stock_uom);
  push('brand', null, item.brand);
  for (const { field, label } of config.characteristicFields) push(field, label, item[field]);
  return out;
}

async function abmLinks(site: FrappeSite, config: CatalogSiteConfig): Promise<Map<string, AbmLinks['resources']> | AbmLinks['status']> {
  if (!config.abmResources) return 'NOT_CONFIGURED';
  try {
    const [resources, pools] = await Promise.all([
      site.list('ABM Resource', [['enabled', '=', 1]], ['name', 'resource_name', 'resource_type', 'capacity', 'selling_item'], MAX_ITEMS),
      site.list('ABM Equipment Pool', [['enabled', '=', 1]], ['name', 'item'], MAX_ITEMS),
    ]);
    const byItem = new Map<string, any[]>();
    const link = (item: unknown, resource: any) => { if (text(item)) byItem.set(item as string, [...(byItem.get(item as string) ?? []), resource]); };
    for (const r of resources) link(r.selling_item, {
      id: r.name, name: text(r.resource_name) ?? r.name, type: r.resource_type === 'Equipment' ? 'EQUIPMENT' : 'SPACE',
      capacity: Number.isInteger(Number(r.capacity)) && Number(r.capacity) > 0 ? Number(r.capacity) : null,
    });
    for (const p of pools) link(p.item, { id: p.name, name: p.name, type: 'EQUIPMENT', capacity: null });
    return byItem as Map<string, AbmLinks['resources']>;
  } catch (error) {
    // The app is optional per site: a missing DocType is reported, not an outage of the catalogue.
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && error.httpStatus === 404) return 'NOT_INSTALLED';
    console.error('[public-catalog] ABM resources unavailable', error instanceof FrappeSiteError ? error.code : typeof error);
    return 'UNAVAILABLE';
  }
}

async function loadSnapshot(context: PublicSiteContext, site: FrappeSite, config: CatalogSiteConfig, today: string): Promise<Snapshot> {
  const filters: Filter[] = [['disabled', '=', 0], ['is_sales_item', '=', 1], ['has_variants', '=', 0]];
  if (config.itemGroups) filters.push(['item_group', 'in', config.itemGroups]);
  if (config.publishedField) filters.push([config.publishedField, '=', 1]);
  const fields = [...new Set(['name', 'item_name', 'item_group', 'stock_uom', 'sales_uom', 'brand', 'description', 'image', 'variant_of',
    'creation', ...config.characteristicFields.map(c => c.field)])];
  const [items, priceRows, files, abm] = await Promise.all([
    site.list('Item', filters, fields, MAX_ITEMS + 1),
    site.list('Item Price', [['price_list', 'in', config.priceLists], ['selling', '=', 1]],
      ['item_code', 'price_list', 'price_list_rate', 'currency', 'uom', 'valid_from', 'valid_upto', 'customer', 'batch_no'], 20 * MAX_ITEMS),
    site.list('File', [['attached_to_doctype', '=', 'Item'], ['is_private', '=', 0]],
      ['name', 'file_url', 'is_private', 'attached_to_name', 'creation'], 20 * MAX_ITEMS),
    abmLinks(site, config),
  ]);
  for (const [doctype, rows, max] of [['Item', items, MAX_ITEMS + 1], ['Item Price', priceRows, 20 * MAX_ITEMS], ['File', files, 20 * MAX_ITEMS]] as const)
    if (rows.length >= max) console.warn('[public-catalog] read truncated', JSON.stringify({ site: context.siteId, doctype, max }));
  const prices = publicPrices(priceRows, config.priceLists, today);
  const filesByItem = new Map<string, FileRow[]>();
  for (const file of files as FileRow[]) if (file.attached_to_name) filesByItem.set(file.attached_to_name, [...(filesByItem.get(file.attached_to_name) ?? []), file]);

  // The oldest Item keeps a bare slug; a later Item with the same slug gets a stable suffix,
  // so creating an Item never changes a slug already published.
  const rows = items.slice(0, MAX_ITEMS);
  const slugOwner = new Map<string, string>();
  for (const item of [...rows].sort((a, b) => String(a.creation ?? '').localeCompare(String(b.creation ?? '')) || a.name.localeCompare(b.name)))
    if (!slugOwner.has(itemSlug(item.name))) slugOwner.set(itemSlug(item.name), item.name);
  const mediaOrigin = config.mediaOrigin?.replace(/\/$/, '') ?? (INTERNAL_HOST.test(site.host) ? null : `https://${site.host}`);
  const entries = rows.map((item): Entry => {
    const base = itemSlug(item.name);
    const name = text(item.item_name) ?? item.name;
    const description = plainText(item.description);
    const resources = abm instanceof Map ? { status: 'AVAILABLE' as const, resources: abm.get(item.name) ?? [] } : { status: abm, resources: [] as [] };
    return {
      id: item.name,
      slug: slugOwner.get(base) === item.name ? base : `${base}-${shortHash(item.name)}`,
      name,
      group: text(item.item_group),
      // ERPNext copies item_name into description by default: that is not a description.
      description: description && description !== name ? description : null,
      variantOf: text(item.variant_of),
      uom: text(item.sales_uom) ?? text(item.stock_uom),
      characteristics: characteristics(item, config),
      prices: prices.get(item.name) ?? [],
      media: itemMedia(item.image, filesByItem.get(item.name) ?? [], site.host, config.virtualTourHosts, mediaOrigin),
      resources,
    };
  }).sort((a, b) => String(a.group).localeCompare(String(b.group)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { site: context, priceLists: config.priceLists, entries, attributes: new Map() };
}

export async function catalogSnapshot(context: PublicSiteContext, site: FrappeSite, config: CatalogSiteConfig, now: Date): Promise<Snapshot> {
  const key = `${context.siteId}\u0000${context.frappeSiteKey}\u0000${JSON.stringify(config)}`;
  const cached = SNAPSHOTS.get(key);
  if (cached && now.getTime() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = loadSnapshot(context, site, config, localDate(now, config.timezone));
  SNAPSHOTS.set(key, { at: now.getTime(), value });
  // A failed read is not cached: the next request retries Frappe.
  value.catch(() => { if (SNAPSHOTS.get(key)?.value === value) SNAPSHOTS.delete(key); });
  return value;
}

// ── public views ──────────────────────────────────────────────────────────

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pricesIn = (entry: Entry, currency?: string) => currency ? entry.prices.filter(p => p.currency === currency) : entry.prices;

/**
 * The headline price: in the first public list that prices the item, the rate ERPNext
 * applies today (latest valid_from) in the item's sales unit, else the lowest such rate.
 */
function priceSummary(prices: PublicPrice[], uom: string | null): PriceSummary {
  const current = prices.filter(p => p.current);
  if (!current.length) return { status: 'NOT_PRICED', from: null };
  const inList = current.filter(p => p.priceList === current[0].priceList);
  const effective = [...new Set(inList.map(p => p.uom))].map(unit => inList.filter(p => p.uom === unit)
    .reduce((best, p) => String(p.validFrom ?? '') > String(best.validFrom ?? '') ? p : best));
  const from = effective.find(p => p.uom === uom) ?? effective.reduce((low, p) => p.amount < low.amount ? p : low);
  return { status: 'PRICED', from };
}

function summary(entry: Entry, currency?: string) {
  const cover = entry.media.find(m => m.isCover) ?? null;
  const count = (kind: MediaAsset['kind']) => entry.media.filter(m => m.kind === kind).length;
  return {
    id: entry.id, slug: entry.slug, name: entry.name, group: entry.group,
    shortDescription: entry.description ? (entry.description.length > 280 ? entry.description.slice(0, 279).trimEnd() + '…' : entry.description) : null,
    cover, price: priceSummary(pricesIn(entry, currency), entry.uom),
    mediaCount: { images: count('IMAGE'), videos: count('VIDEO'), virtualTours: count('VIRTUAL_TOUR') },
  };
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
function decodeCursor(value?: string): number {
  if (!value) return 0;
  try {
    const offset = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))?.o;
    if (Number.isInteger(offset) && offset >= 0 && offset <= MAX_ITEMS) return offset;
  } catch { /* invalid below */ }
  throw new InvalidCursor();
}

export function listView(snapshot: Snapshot, query: CatalogListQuery) {
  const offset = decodeCursor(query.cursor);
  const needle = query.q ? fold(query.q) : null;
  const matching = snapshot.entries.filter(entry => {
    if (query.group && entry.group !== query.group) return false;
    if (needle && ![entry.name, entry.id, entry.description ?? ''].some(value => fold(value).includes(needle))) return false;
    if (query.priced) return (priceSummary(pricesIn(entry, query.currency), entry.uom).status === 'PRICED') === (query.priced === 'true');
    return true;
  });
  const groups = [...snapshot.entries.reduce((counts, entry) => entry.group ? counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1) : counts, new Map<string, number>())]
    .map(([name, count]) => ({ name, count }));
  const page = matching.slice(offset, offset + query.limit);
  return {
    site: { id: snapshot.site.siteId, kind: snapshot.site.kind },
    priceLists: snapshot.priceLists,
    groups,
    total: matching.length,
    items: page.map(entry => summary(entry, query.currency)),
    nextCursor: offset + query.limit < matching.length ? encodeCursor(offset + query.limit) : null,
  };
}

export const findEntry = (snapshot: Snapshot, ref: string) =>
  snapshot.entries.find(e => e.id === ref) ?? snapshot.entries.find(e => e.slug === ref) ?? null;

/**
 * Variant attributes are a child table of Item: read for a requested variant only, once per
 * snapshot. An Item deleted since the snapshot simply has none.
 */
export function variantAttributes(site: FrappeSite, snapshot: Snapshot, entry: Entry): Promise<Characteristic[]> {
  if (!entry.variantOf) return Promise.resolve([]);
  const cached = snapshot.attributes.get(entry.id);
  if (cached) return cached;
  const read = site.get('Item', entry.id).then(
    (doc: any) => (Array.isArray(doc?.attributes) ? doc.attributes : [])
      .filter((row: any) => text(row?.attribute) && plainText(String(row.attribute_value ?? '')))
      .map((row: any) => ({ key: 'attribute:' + row.attribute, label: row.attribute, value: plainText(String(row.attribute_value))! })),
    (error: unknown) => {
      if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && error.httpStatus === 404) return [];
      throw error;
    });
  snapshot.attributes.set(entry.id, read);
  read.catch(() => { if (snapshot.attributes.get(entry.id) === read) snapshot.attributes.delete(entry.id); });
  return read;
}

export function detailView(snapshot: Snapshot, entry: Entry, attributes: Characteristic[] = [], currency?: string) {
  const prices = pricesIn(entry, currency);
  return {
    site: { id: snapshot.site.siteId, kind: snapshot.site.kind },
    item: {
      ...summary(entry, currency),
      description: entry.description,
      variantOf: entry.variantOf,
      characteristics: [...entry.characteristics, ...attributes],
      prices,
      media: entry.media,
      resources: entry.resources,
    },
  };
}

export const etag = (value: unknown) => `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`;

/** True when an If-None-Match header names this entity tag (weak comparison, RFC 9110). */
export function notModified(ifNoneMatch: string | null, tag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.trim() === '*' || ifNoneMatch.split(',').some(value => value.trim().replace(/^W\//, '') === tag);
}

/** Response contracts of GET /api/public/catalog/items and GET /api/public/catalog/items/{ref}. */
export type PublicCatalogListResponse = ReturnType<typeof listView>;
export type PublicCatalogItemResponse = ReturnType<typeof detailView>;
