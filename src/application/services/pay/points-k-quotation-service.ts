/**
 * Points K purchase, flow 1: draft ERPNext Quotation for a maximum TTC budget.
 *
 *   selected country -> payment_country_mappings -> konektag-<country> -> Frappe site
 *   Customer (alias = Keycloak subject) <-> Lead (Lead.customer, Customer.lead_name)
 *   -> Item / Item Price / Price List of that site in the requested currency
 *   -> draft Quotation (quotation_to = Lead) whose quantity is the largest
 *      integer whose rounded TTC total stays within the budget.
 *
 * Prices, taxes and totals come only from ERPNext: the Quotation is saved and
 * ERPNext applies its Tax Rule / template and computes the totals on each save.
 * The quantity is searched on that single draft; no rate is computed here.
 * Repeated calls reuse the Customer, the Lead and the draft of the day, and are
 * serialized per user and site by a PostgreSQL advisory lock.
 */
import { konektagFrappeSite, routeKonektagFlow, type KonektagSiteRoute } from '../../shared/konektag-site.ts';
import { FrappeSiteError, type FrappeSite } from '../../marketplace-transactions/frappe-site.ts';

export type PointsKQuotationErrorCode =
  | 'KEYCLOAK_IDENTITY_MISSING'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_NOT_SALEABLE'
  | 'PRICE_NOT_FOUND'
  | 'PRICE_INVALID'
  | 'PRICE_AMBIGUOUS'
  | 'NO_PURCHASE_POSSIBLE'
  | 'CUSTOMER_IDENTITY_MISMATCH'
  | 'CUSTOMER_DISABLED'
  | 'QUOTATION_INCONSISTENT'
  | 'QUANTITY_NOT_CONVERGED'
  | 'QUOTATION_BUSY'
  | 'ERPNEXT_REJECTED'
  | 'ERPNEXT_UNAVAILABLE';

export class PointsKQuotationError extends Error {
  constructor(readonly code: PointsKQuotationErrorCode, readonly detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'PointsKQuotationError';
  }
}

export function pointsKQuotationErrorStatus(code: PointsKQuotationErrorCode): number {
  switch (code) {
    case 'KEYCLOAK_IDENTITY_MISSING': return 401;
    case 'ITEM_NOT_FOUND': case 'ITEM_NOT_SALEABLE': case 'PRICE_NOT_FOUND': case 'PRICE_INVALID': case 'NO_PURCHASE_POSSIBLE': return 422;
    case 'CUSTOMER_DISABLED': case 'QUOTATION_BUSY': return 409;
    case 'CUSTOMER_IDENTITY_MISMATCH': case 'QUOTATION_INCONSISTENT': case 'ERPNEXT_REJECTED': return 502;
    default: return 503;
  }
}

export type PointsKQuotationInput = {
  keycloakId: string;
  displayName: string;
  country: string;
  currency: string;
  budget: number;
  itemCode: string;
};

export type PointsKQuotationResult = {
  konektagSite: string;
  paymentCountry: string;
  site: { key: string; host: string };
  customer: { name: string; created: boolean };
  lead: { name: string; created: boolean };
  quotation: {
    name: string;
    created: boolean;
    docstatus: 0;
    status: string | null;
    company: string | null;
    currency: string;
    sellingPriceList: string;
    itemCode: string;
    qty: number;
    rate: number;
    priceListRate: number;
    netTotal: number;
    totalTaxesAndCharges: number;
    grandTotal: number;
    roundingAdjustment: number;
    roundedTotal: number;
    roundedTotalDisabled: boolean;
    total: number;
    taxesAndCharges: string | null;
    taxes: Array<{ chargeType: string | null; accountHead: string | null; description: string | null; rate: number; taxAmount: number; total: number }>;
  };
  budget: number;
};

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };
type LockClient = Queryable & { release: () => void };
type Deps = {
  connect?: () => Promise<LockClient>;
  site?: (route: KonektagSiteRoute) => FrappeSite;
  route?: (country: string) => Promise<KonektagSiteRoute>;
  today?: (timezone: string) => string;
};

const MAX_EVALUATIONS = 12;
const MAX_QTY = 1_000_000_000;

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
};

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Frappe errors keep their HTTP meaning; a 404 on a known document is the caller's input. */
function erpnextError(error: unknown): PointsKQuotationError {
  if (error instanceof PointsKQuotationError) return error;
  if (error instanceof FrappeSiteError) {
    const detail = { httpStatus: error.httpStatus, excType: error.excType, message: error.serverMessage };
    return new PointsKQuotationError(error.code === 'SITE_REJECTED' ? 'ERPNEXT_REJECTED' : 'ERPNEXT_UNAVAILABLE', detail);
  }
  return new PointsKQuotationError('ERPNEXT_UNAVAILABLE');
}

const isNotFound = (error: unknown) => error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && error.httpStatus === 404;

/** The Item must exist on the site, be enabled and saleable. */
async function readItem(site: FrappeSite, itemCode: string) {
  let item: any;
  try { item = await site.get('Item', itemCode); } catch (error) {
    if (isNotFound(error)) throw new PointsKQuotationError('ITEM_NOT_FOUND', { itemCode });
    throw erpnextError(error);
  }
  if (!item?.name || item.name !== itemCode) throw new PointsKQuotationError('ITEM_NOT_FOUND', { itemCode });
  if (Number(item.disabled) === 1 || Number(item.is_sales_item) === 0 || Number(item.has_variants) === 1)
    throw new PointsKQuotationError('ITEM_NOT_SALEABLE', { itemCode });
  return { name: String(item.name), stockUom: item.stock_uom ? String(item.stock_uom) : null };
}

/**
 * The selling price of the item in the requested currency: an Item Price with no
 * customer restriction, valid today, in the stock UOM, on an enabled selling
 * Price List of that currency. Several candidate lists are refused rather than chosen.
 */
async function readPrice(site: FrappeSite, item: { name: string; stockUom: string | null }, currency: string, today: string) {
  const rows = await site.list('Item Price',
    [['item_code', '=', item.name], ['selling', '=', 1], ['currency', '=', currency]],
    ['name', 'price_list', 'price_list_rate', 'currency', 'uom', 'customer', 'valid_from', 'valid_upto'], 50) as any[];
  const valid = (rows ?? []).filter(row => row.currency === currency && !row.customer
    && (!row.uom || !item.stockUom || row.uom === item.stockUom)
    && (!row.valid_from || String(row.valid_from) <= today)
    && (!row.valid_upto || String(row.valid_upto) >= today));
  const lists = new Map<string, any>();
  for (const row of valid) {
    let list: any;
    try { list = await site.get('Price List', String(row.price_list)); } catch (error) {
      if (isNotFound(error)) continue;
      throw erpnextError(error);
    }
    if (Number(list?.enabled) === 1 && Number(list?.selling) === 1 && list?.currency === currency) lists.set(String(row.price_list), row);
  }
  if (lists.size === 0) throw new PointsKQuotationError('PRICE_NOT_FOUND', { itemCode: item.name, currency });
  if (lists.size > 1) throw new PointsKQuotationError('PRICE_AMBIGUOUS', { itemCode: item.name, currency, priceLists: [...lists.keys()] });
  const [[priceList, row]] = [...lists.entries()];
  const rate = num(row.price_list_rate);
  if (!(rate > 0)) throw new PointsKQuotationError('PRICE_INVALID', { itemCode: item.name, currency, priceList });
  return { priceList, rate };
}

/** Customer of the site whose alias is the Keycloak subject; created once, never matched otherwise. */
async function ensureCustomer(site: FrappeSite, keycloakId: string, displayName: string) {
  const find = async () => {
    const rows = await site.list('Customer', [['alias', '=', keycloakId]], ['name', 'alias', 'disabled', 'lead_name'], 2) as any[];
    if ((rows ?? []).length > 1) throw new PointsKQuotationError('CUSTOMER_IDENTITY_MISMATCH', { reason: 'ALIAS_NOT_UNIQUE' });
    return rows?.[0] ?? null;
  };
  let customer = await find();
  let created = false;
  if (!customer) {
    try {
      customer = await site.insert('Customer', { customer_name: displayName, customer_type: 'Individual', alias: keycloakId });
      created = true;
    } catch (error) {
      // alias is unique: a concurrent creation on another replica is reused.
      customer = await find();
      if (!customer) throw erpnextError(error);
    }
  }
  if (!customer?.name || customer.alias !== keycloakId) throw new PointsKQuotationError('CUSTOMER_IDENTITY_MISMATCH');
  if (Number(customer.disabled) === 1) throw new PointsKQuotationError('CUSTOMER_DISABLED');
  return { name: String(customer.name), created, leadName: customer.lead_name ? String(customer.lead_name) : null };
}

/**
 * The Lead of the Customer, linked both ways by native fields:
 *   Lead.customer = Customer.name, and Customer.lead_name = Lead.name.
 * ERPNext's Quotation -> Sales Order mapper (make_sales_order -> _make_customer ->
 * get_existing_customer_name) finds the Customer only by Customer.lead_name;
 * without it, it creates a second Customer from the Lead, without the alias.
 *
 * Setting Customer.lead_name makes ERPNext mark the Lead Converted and move that
 * Lead's existing Quotations to the Customer (Customer.update_lead_status), so the
 * link is always set before any Quotation of this flow is created for the Lead.
 */
async function ensureLead(site: FrappeSite, customer: { name: string; leadName: string | null }, displayName: string) {
  let lead: { name: string; created: boolean };
  if (customer.leadName) {
    // The Customer already comes from a Lead: the only one the mapper can resolve.
    let doc: any;
    try { doc = await site.get('Lead', customer.leadName); } catch (error) {
      if (isNotFound(error)) throw new PointsKQuotationError('CUSTOMER_IDENTITY_MISMATCH', { reason: 'CUSTOMER_LEAD_NOT_FOUND' });
      throw erpnextError(error);
    }
    if (doc?.name !== customer.leadName || (doc.customer && doc.customer !== customer.name))
      throw new PointsKQuotationError('CUSTOMER_IDENTITY_MISMATCH', { reason: 'LEAD_CUSTOMER_MISMATCH' });
    if (Number(doc.disabled) === 1) throw new PointsKQuotationError('CUSTOMER_DISABLED', { reason: 'LEAD_DISABLED' });
    if (!doc.customer) {
      const updated = await site.update('Lead', doc.name, { customer: customer.name });
      if (updated?.customer !== customer.name) throw new PointsKQuotationError('QUOTATION_INCONSISTENT', { reason: 'LEAD_CUSTOMER_NOT_SET' });
    }
    lead = { name: String(doc.name), created: false };
  } else {
    // A Lead converted to another Customer is not reused.
    const rows = await site.list('Lead', [['customer', '=', customer.name]], ['name', 'customer', 'status', 'disabled', 'creation'], 50) as any[];
    const usable = (rows ?? [])
      .filter(row => row.customer === customer.name && Number(row.disabled) !== 1 && row.status !== 'Do Not Contact' && row.status !== 'Converted')
      .sort((a, b) => String(a.creation ?? '').localeCompare(String(b.creation ?? '')) || String(a.name).localeCompare(String(b.name)));
    if (usable[0]) lead = { name: String(usable[0].name), created: false };
    else {
      const doc = await site.insert('Lead', { first_name: displayName, customer: customer.name });
      if (!doc?.name || doc.customer !== customer.name) throw new PointsKQuotationError('QUOTATION_INCONSISTENT', { reason: 'LEAD_CUSTOMER_NOT_SET' });
      lead = { name: String(doc.name), created: true };
    }
    // Only lead_name is written: the alias is left as it is.
    const updated = await site.update('Customer', customer.name, { lead_name: lead.name });
    if (updated?.lead_name !== lead.name) throw new PointsKQuotationError('QUOTATION_INCONSISTENT', { reason: 'CUSTOMER_LEAD_NOT_SET' });
  }
  // Same lookup as get_existing_customer_name("Lead", lead): it must resolve to this Customer only.
  const owners = await site.list('Customer', [['lead_name', '=', lead.name]], ['name'], 2) as any[];
  if ((owners ?? []).length !== 1 || owners[0].name !== customer.name)
    throw new PointsKQuotationError('CUSTOMER_IDENTITY_MISMATCH', { reason: 'LEAD_CUSTOMER_AMBIGUOUS' });
  return lead;
}

/** Today's draft Quotation of this Lead for the same item, list and currency. */
async function findDraft(site: FrappeSite, lead: string, currency: string, priceList: string, itemCode: string, today: string) {
  const rows = await site.list('Quotation',
    [['quotation_to', '=', 'Lead'], ['party_name', '=', lead], ['docstatus', '=', 0], ['currency', '=', currency],
      ['selling_price_list', '=', priceList], ['transaction_date', '=', today]],
    ['name', 'creation'], 20) as any[];
  for (const row of [...(rows ?? [])].sort((a, b) => String(a.creation ?? '').localeCompare(String(b.creation ?? '')))) {
    const doc = await site.get('Quotation', String(row.name));
    if (Number(doc?.docstatus) === 0 && doc.quotation_to === 'Lead' && doc.party_name === lead
      && Array.isArray(doc.items) && doc.items.length === 1 && doc.items[0].item_code === itemCode) return doc;
  }
  return null;
}

/** Rounded TTC total as ERPNext defines it: grand_total when rounding is disabled on the document. */
function documentTotal(doc: any): number {
  return Number(doc.disable_rounded_total) === 1 ? num(doc.grand_total) : num(doc.rounded_total);
}

function checkComputed(doc: any, expected: { lead: string; currency: string; priceList: string; itemCode: string; qty: number }) {
  const item = Array.isArray(doc?.items) && doc.items.length === 1 ? doc.items[0] : null;
  const total = documentTotal(doc ?? {});
  if (!doc?.name || Number(doc.docstatus) !== 0 || doc.quotation_to !== 'Lead' || doc.party_name !== expected.lead
    || doc.currency !== expected.currency || doc.selling_price_list !== expected.priceList
    || !item || item.item_code !== expected.itemCode || num(item.qty) !== expected.qty || !Number.isFinite(total))
    throw new PointsKQuotationError('QUOTATION_INCONSISTENT', { quotation: doc?.name ?? null });
  return total;
}

const fits = (total: number, budget: number) => total <= budget + 1e-9;

/**
 * Largest integer quantity whose ERPNext total fits the budget. Each evaluation
 * saves the draft and reads the totals ERPNext computed (taxes included). The
 * next guess extrapolates the observed per-unit total; it is only a guess, the
 * result is proven by total(q) <= budget < total(q + 1) on the document itself.
 */
async function searchQuantity(evaluate: (qty: number) => Promise<{ total: number; doc: any }>, budget: number, firstGuess: number) {
  let lo = 0, loTotal = 0, hi = Infinity, evaluations = 0;
  let last: { qty: number; total: number; doc: any } | null = null;
  let guess = Math.min(Math.max(1, firstGuess), MAX_QTY);
  for (;;) {
    if (evaluations++ >= MAX_EVALUATIONS) throw new PointsKQuotationError('QUANTITY_NOT_CONVERGED');
    const { total, doc } = await evaluate(guess);
    last = { qty: guess, total, doc };
    if (fits(total, budget)) { lo = guess; loTotal = total; } else hi = guess;
    if (hi === 1) throw new PointsKQuotationError('NO_PURCHASE_POSSIBLE', { budget, totalForOne: total, quotation: doc?.name ?? null });
    if (hi - lo <= 1 || lo >= MAX_QTY) break;
    // Extrapolate the per-unit total just observed; bisect every third step once bounded.
    const unit = total / guess;
    let next = unit > 0 ? (lo > 0 ? lo + Math.floor((budget - loTotal) / unit) : Math.floor(budget / unit)) : NaN;
    if (!Number.isFinite(next) || (hi !== Infinity && evaluations % 3 === 0)) next = hi === Infinity ? lo * 2 : Math.floor((lo + hi) / 2);
    guess = Math.min(Math.max(next, lo + 1), hi - 1, MAX_QTY);
  }
  // The draft must end on the chosen quantity.
  const doc = last.qty === lo ? last.doc : (await evaluate(lo)).doc;
  return { qty: lo, doc };
}

function publicTaxes(doc: any) {
  return (Array.isArray(doc.taxes) ? doc.taxes : []).map((tax: any) => ({
    chargeType: tax.charge_type ?? null, accountHead: tax.account_head ?? null, description: tax.description ?? null,
    rate: num(tax.rate) || 0, taxAmount: num(tax.tax_amount) || 0, total: num(tax.total) || 0,
  }));
}

async function defaultConnect(): Promise<LockClient> {
  const pool = (await import('../../../infrastructure/database/pool.ts')).default;
  return pool.connect();
}

export async function createPointsKQuotation(input: PointsKQuotationInput, deps: Deps = {}): Promise<PointsKQuotationResult> {
  const keycloakId = String(input.keycloakId ?? '').trim();
  if (!keycloakId) throw new PointsKQuotationError('KEYCLOAK_IDENTITY_MISSING');
  const route = await (deps.route ?? (country => routeKonektagFlow('points-k-quotation', country)))(input.country);
  const site = (deps.site ?? (r => konektagFrappeSite(r)))(route);
  const today = (deps.today ?? todayIn)(route.timezone);
  const displayName = String(input.displayName ?? '').trim() || keycloakId;

  const client = await (deps.connect ?? defaultConnect)().catch(() => { throw new PointsKQuotationError('ERPNEXT_UNAVAILABLE', { reason: 'LOCK_UNAVAILABLE' }); });
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['points-k-quotation|' + route.site + '|' + keycloakId]);
    } catch {
      throw new PointsKQuotationError('QUOTATION_BUSY');
    }
    try {
      const item = await readItem(site, input.itemCode);
      const price = await readPrice(site, item, input.currency, today);
      const customer = await ensureCustomer(site, keycloakId, displayName);
      const lead = await ensureLead(site, customer, displayName);
      const draft = await findDraft(site, lead.name, input.currency, price.priceList, item.name, today);
      let name: string | null = draft?.name ?? null;
      const expected = { lead: lead.name, currency: input.currency, priceList: price.priceList, itemCode: item.name };
      const row = (qty: number) => [{ item_code: item.name, qty, ...(item.stockUom ? { uom: item.stockUom } : {}) }];
      const evaluate = async (qty: number) => {
        const doc = name
          ? await site.update('Quotation', name, { items: row(qty) })
          : await site.insert('Quotation', {
            quotation_to: 'Lead', party_name: lead.name, order_type: 'Sales', transaction_date: today,
            currency: input.currency, selling_price_list: price.priceList, items: row(qty),
          });
        name = doc?.name ?? name;
        return { total: checkComputed(doc, { ...expected, qty }), doc };
      };
      // First guess from the HT list price only; ERPNext decides the result.
      const { qty, doc } = await searchQuantity(evaluate, input.budget, Math.floor(input.budget / price.rate));
      const item0 = doc.items[0];
      return {
        konektagSite: route.slug,
        paymentCountry: route.paymentCountry,
        site: { key: site.key, host: site.host },
        customer: { name: customer.name, created: customer.created },
        lead,
        quotation: {
          name: String(doc.name), created: !draft, docstatus: 0, status: doc.status ?? null, company: doc.company ?? null,
          currency: doc.currency, sellingPriceList: doc.selling_price_list, itemCode: item0.item_code, qty,
          rate: num(item0.rate), priceListRate: num(item0.price_list_rate),
          netTotal: num(doc.net_total), totalTaxesAndCharges: num(doc.total_taxes_and_charges) || 0,
          grandTotal: num(doc.grand_total), roundingAdjustment: num(doc.rounding_adjustment) || 0,
          roundedTotal: num(doc.rounded_total) || 0, roundedTotalDisabled: Number(doc.disable_rounded_total) === 1,
          total: documentTotal(doc), taxesAndCharges: doc.taxes_and_charges ?? null, taxes: publicTaxes(doc),
        },
        budget: input.budget,
      };
    } catch (error) {
      throw erpnextError(error);
    }
  } finally {
    if (open) await client.query('COMMIT').catch(() => undefined);
    client.release();
  }
}
