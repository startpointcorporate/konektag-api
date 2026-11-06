import type { FrappeSite } from './frappe-site.ts';
import type { RestaurantCapability } from './merchant-capabilities.ts';

/**
 * Restaurant orders through Lumen (lumen_restaurants) on the merchant's site.
 *
 * Prices, availability and currency are always re-read from Frappe: the
 * outlet's POS Profile names the selling price list, and only Item Price rows
 * in effect today count, as Lumen's own price_books.get_price_map does.
 * An order is a native POS Restaurant Order opened with
 * restaurant.open_order(app_type=<channel>, order_id=<Idempotency-Key>) and
 * filled with restaurant.save_order(cart). The till pays it as usual.
 */

export interface CartLineInput { itemCode: string; quantity: number; unitPrice: number }
export interface PricedLine { itemCode: string; itemName: string; quantity: number; unitPrice: number; amount: number }
export interface PriceChange { itemCode: string; expectedUnitPrice: number; currentUnitPrice: number }
export interface Quote {
  currency: string;
  lines: PricedLine[];
  total: number;
  priceChanges: PriceChange[];
  unavailableItems: string[];
}

export class RestaurantError extends Error {
  constructor(
    readonly code: 'RESTAURANT_UNAVAILABLE' | 'CURRENCY_MISMATCH' | 'ITEM_UNAVAILABLE' | 'PRICE_CHANGED' | 'ORDER_NOT_RECORDED',
    readonly quote?: Quote,
  ) { super(code); }
}

const money = (value: number) => Math.round(value * 100) / 100;

function inEffect(row: any, today: string) {
  if (row.valid_from && today < String(row.valid_from).slice(0, 10)) return false;
  if (row.valid_upto && today > String(row.valid_upto).slice(0, 10)) return false;
  return Number(row.price_list_rate) > 0;
}

async function openOutlet(site: FrappeSite, cap: RestaurantCapability) {
  const profile = await site.get('POS Profile', cap.posProfile);
  if (!profile || Number(profile.disabled) || !Number(profile.lumenpos_restaurant_mode) || !profile.selling_price_list)
    throw new RestaurantError('RESTAURANT_UNAVAILABLE');
  const priceList = await site.get('Price List', profile.selling_price_list);
  if (!priceList || Number(priceList.enabled) === 0 || !priceList.currency) throw new RestaurantError('RESTAURANT_UNAVAILABLE');
  const listed: string[] = (profile.item_groups ?? []).map((row: any) => row.item_group).filter(Boolean);
  return { profile, currency: String(priceList.currency), listed: listed.includes('All Item Groups') ? [] : listed };
}

/** Latest valid_from wins among rows in effect, in the item's stock UOM. */
async function pricesOf(site: FrappeSite, priceList: string, items: any[], today: string) {
  const byCode = new Map<string, any>(items.map((item: any) => [item.name, item]));
  const codes = [...byCode.keys()];
  const prices = codes.length ? await site.list('Item Price', [['price_list', '=', priceList], ['item_code', 'in', codes], ['selling', '=', 1]],
    ['item_code', 'price_list_rate', 'uom', 'valid_from', 'valid_upto'], Math.max(500, codes.length * 4)) : [];
  const priceByCode = new Map<string, number>();
  const sorted = [...prices].sort((a: any, b: any) => String(a.valid_from ?? '').localeCompare(String(b.valid_from ?? '')));
  for (const row of sorted) {
    const item = byCode.get(row.item_code);
    if (!item || (row.uom && row.uom !== item.stock_uom) || !inEffect(row, today)) continue;
    priceByCode.set(row.item_code, Number(row.price_list_rate));
  }
  return priceByCode;
}

/** {item group: the listed section it falls under}, or null when the outlet lists none. */
async function sectionsOf(site: FrappeSite, listed: string[], groups: string[]) {
  if (!listed.length) return null;
  const names = [...new Set([...listed, ...groups])];
  const tree = await site.list('Item Group', [['name', 'in', names]], ['name', 'lft', 'rgt'], names.length);
  const bounds = new Map<string, any>(tree.map((g: any) => [g.name, g]));
  const roots = listed.map(name => bounds.get(name)).filter(Boolean);
  const out = new Map<string, string>();
  for (const group of groups) {
    const g = bounds.get(group);
    const root = g && roots.find(r => Number(g.lft) >= Number(r.lft) && Number(g.rgt) <= Number(r.rgt));
    if (root) out.set(group, root.name);
  }
  return out;
}

const ITEM_FIELDS = ['name', 'item_name', 'item_group', 'stock_uom', 'is_sales_item', 'disabled', 'has_variants', 'description'];
const orderable = (item: any) => Number(item.is_sales_item) && !Number(item.disabled) && !Number(item.has_variants);
const plain = (html: unknown) => typeof html === 'string'
  ? html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined : undefined;

export async function quoteCart(site: FrappeSite, cap: RestaurantCapability, lines: CartLineInput[], currency: string, today = new Date().toISOString().slice(0, 10)): Promise<Quote> {
  const outlet = await openOutlet(site, cap);
  if (outlet.currency !== currency) throw new RestaurantError('CURRENCY_MISMATCH');
  const codes = [...new Set(lines.map(line => line.itemCode))];
  const items = await site.list('Item', [['name', 'in', codes]], ITEM_FIELDS, codes.length);
  const itemByCode = new Map<string, any>(items.map((item: any) => [item.name, item]));
  const [priceByCode, sections] = await Promise.all([
    pricesOf(site, outlet.profile.selling_price_list, items, today),
    sectionsOf(site, outlet.listed, [...new Set(items.map((i: any) => i.item_group))] as string[]),
  ]);

  const unavailableItems: string[] = [];
  const priceChanges: PriceChange[] = [];
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const item = itemByCode.get(line.itemCode);
    const price = priceByCode.get(line.itemCode);
    if (!item || !orderable(item) || (sections && !sections.has(item.item_group)) || price === undefined) {
      if (!unavailableItems.includes(line.itemCode)) unavailableItems.push(line.itemCode);
      continue;
    }
    const unitPrice = money(price);
    if (Math.abs(unitPrice - line.unitPrice) >= 0.005 && !priceChanges.some(c => c.itemCode === line.itemCode))
      priceChanges.push({ itemCode: line.itemCode, expectedUnitPrice: line.unitPrice, currentUnitPrice: unitPrice });
    priced.push({ itemCode: line.itemCode, itemName: String(item.item_name || line.itemCode), quantity: line.quantity, unitPrice, amount: money(unitPrice * line.quantity) });
  }
  return { currency, lines: priced, total: money(priced.reduce((sum, line) => sum + line.amount, 0)), priceChanges, unavailableItems };
}

export interface Menu { currency: string; sections: { name: string; dishes: { itemCode: string; name: string; description?: string; price: number }[] }[] }

/**
 * The outlet's orderable dishes with today's prices: what quoteCart accepts,
 * so a dish on the page is a dish the order validation agrees with.
 */
export async function menuOf(site: FrappeSite, cap: RestaurantCapability, today = new Date().toISOString().slice(0, 10)): Promise<Menu> {
  const outlet = await openOutlet(site, cap);
  let groups: string[] | null = null;
  if (outlet.listed.length) {
    const roots = await site.list('Item Group', [['name', 'in', outlet.listed]], ['name', 'lft', 'rgt'], outlet.listed.length);
    const below = await Promise.all(roots.map((r: any) =>
      site.list('Item Group', [['lft', '>=', Number(r.lft)], ['rgt', '<=', Number(r.rgt)]], ['name'], 500)));
    groups = [...new Set(below.flat().map((g: any) => g.name))];
    if (!groups.length) return { currency: outlet.currency, sections: [] };
  }
  const filters: [string, string, unknown][] = [['is_sales_item', '=', 1], ['disabled', '=', 0], ['has_variants', '=', 0]];
  if (groups) filters.push(['item_group', 'in', groups]);
  const items = (await site.list('Item', filters, ITEM_FIELDS, 1000)).filter(orderable);
  const [priceByCode, sections] = await Promise.all([
    pricesOf(site, outlet.profile.selling_price_list, items, today),
    sectionsOf(site, outlet.listed, [...new Set(items.map((i: any) => i.item_group))] as string[]),
  ]);
  const bySection = new Map<string, Menu['sections'][number]['dishes']>();
  for (const item of items) {
    const price = priceByCode.get(item.name);
    if (price === undefined) continue; // not sold today: never shown
    const section = sections ? sections.get(item.item_group) : String(item.item_group);
    if (!section) continue;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push({ itemCode: String(item.name), name: String(item.item_name || item.name), description: plain(item.description), price: money(price) });
  }
  const order = outlet.listed.length ? outlet.listed : [...bySection.keys()].sort();
  return {
    currency: outlet.currency,
    sections: order.filter(n => bySection.has(n)).map(name => ({ name, dishes: bySection.get(name)!.sort((a, b) => a.name.localeCompare(b.name)) })),
  };
}

export interface OrderInput {
  lines: CartLineInput[];
  currency: string;
  customer: { name: string; phone: string; email?: string };
  note?: string;
}

export interface RecordedOrder {
  reference: string;
  status: string;
  currency: string;
  total: number;
  lines: PricedLine[];
}

function fromDoc(doc: any, currency: string): RecordedOrder {
  const lines: PricedLine[] = (doc.items ?? []).map((row: any) => ({
    itemCode: String(row.item_code), itemName: String(row.item_name || row.item_code),
    quantity: Number(row.qty), unitPrice: money(Number(row.rate)), amount: money(Number(row.amount)),
  }));
  return { reference: String(doc.name), status: String(doc.status), currency, total: money(lines.reduce((sum, l) => sum + l.amount, 0)), lines };
}

/**
 * Creates the order once per idempotency key. The key is stored by Lumen
 * itself (order_id), so a replay finds the order even without our cache.
 * An attempt that opened the order but failed before saving its cart is
 * resumed, never duplicated.
 */
export async function placeOrder(site: FrappeSite, cap: RestaurantCapability, key: string, input: OrderInput): Promise<RecordedOrder> {
  const existing = await site.list('POS Restaurant Order',
    [['pos_profile', '=', cap.posProfile], ['app_type', '=', cap.channel], ['order_id', '=', key]],
    ['name'], 2);
  let order: any = existing[0] ? await site.get('POS Restaurant Order', existing[0].name) : null;
  if (order && (order.items ?? []).length) return fromDoc(order, input.currency);

  const quote = await quoteCart(site, cap, input.lines, input.currency);
  if (quote.unavailableItems.length) throw new RestaurantError('ITEM_UNAVAILABLE', quote);
  if (quote.priceChanges.length) throw new RestaurantError('PRICE_CHANGED', quote);

  const contact = [input.customer.name, input.customer.phone, input.customer.email].filter(Boolean).join(' · ');
  const note = ['Commande Konektag', contact, input.note?.trim()].filter(Boolean).join('\n').slice(0, 1000);
  if (!order) {
    order = await site.call('lumen_restaurants.api.restaurant.open_order', {
      pos_profile: cap.posProfile, order_type: cap.orderType, guests: 0,
      note, app_type: cap.channel, order_id: key,
    });
  }
  if (order.status !== 'Open') throw new RestaurantError('ORDER_NOT_RECORDED');
  const saved = await site.call('lumen_restaurants.api.restaurant.save_order', {
    name: order.name,
    cart: {
      app_type: cap.channel, order_id: key, note,
      lines: quote.lines.map(line => ({ item_code: line.itemCode, item_name: line.itemName, qty: line.quantity, price: line.unitPrice })),
    },
  });
  if (!saved?.name || saved.name !== order.name) throw new RestaurantError('ORDER_NOT_RECORDED');
  // Answer with what Frappe really stored, not with what we sent.
  return fromDoc(await site.get('POS Restaurant Order', saved.name), quote.currency);
}
