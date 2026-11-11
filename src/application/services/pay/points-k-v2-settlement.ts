/**
 * Points K V2, flux 3: settle a provider-confirmed Points K purchase in ERPNext, then
 * credit the buyer.
 *
 *   verified Stripe/pawaPay event (existing webhooks, attempt amount/currency checked)
 *   -> journal row (konektag.points_k_settlements) with the provider proof
 *   -> ERPNext chain read and checked: Customer, Quotation, Sales Order, Payment Request
 *   -> Sales Invoice made from the Sales Order (native mapper), submitted
 *   -> Payment Entry made from the Sales Invoice (native mapper), linked to the
 *      Payment Request, submitted; ERPNext reflects the payment on the Payment Request
 *   -> item handler by item_code: points_k credits the Quotation K quantity in PostgreSQL
 *
 * Contract with flux 2: the checkout is an existing `wallet_recharge` api_payment_order whose
 * order_metadata.erpnextPointsK names the ERPNext documents (see ErpnextPointsKReference).
 * A browser redirect never reaches this code: only a succeeded provider attempt bound to a
 * verified provider event does. Each step is idempotent and found again in ERPNext after a
 * crash, so a repeated event, the outbox recovery loop or a pawaPay reconciliation resume
 * where processing stopped. Amounts are compared in minor units; the K quantity is only ever
 * the Quotation item quantity, never a TTC amount or a currency amount.
 */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import pool from '../../../infrastructure/database/pool.ts';
import { frappeSite, FrappeSiteError, type FrappeSite } from '../../marketplace-transactions/frappe-site.ts';
import { minorDigits } from './money-unit.ts';
import { confirmPointsAcquisition } from './points-acquisition-service.ts';

type Database = Pick<PoolClient, 'query'>;

const DOC_NAME = z.string().trim().min(1).max(140);
export const erpnextPointsKReference = z.object({
  version: z.literal(1),
  site: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  customer: DOC_NAME,
  quotation: DOC_NAME,
  salesOrder: DOC_NAME,
  paymentRequest: DOC_NAME,
  itemCode: DOC_NAME,
  /** Optional cross-check: the quantity flux 1 showed to the buyer. */
  quantityK: z.number().int().positive().optional(),
}).strict();
export type ErpnextPointsKReference = z.infer<typeof erpnextPointsKReference>;

export type PointsKSettlementErrorCode =
  | 'REFERENCE_INVALID' | 'PROOF_MISSING' | 'PROOF_CONFLICT' | 'DOCUMENT_ALREADY_SETTLED'
  | 'HANDLER_NOT_CONFIGURED' | 'SETTLEMENT_BUSY' | 'ERPNEXT_UNAVAILABLE' | 'ERPNEXT_REJECTED'
  | 'DOCUMENT_MISMATCH' | 'AMOUNT_MISMATCH' | 'QUANTITY_INVALID' | 'DUPLICATE_DOCUMENTS'
  | 'NOT_ACCOUNTED' | 'OWNER_MISMATCH';

export class PointsKSettlementError extends Error {
  constructor(readonly code: PointsKSettlementErrorCode, readonly detail: string = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PointsKSettlementError';
  }
}

/** Reads the flux 2 reference; null for every other order (Link Pay, QR Pay, legacy recharge). */
export function readPointsKReference(metadata: unknown): ErpnextPointsKReference | null {
  const raw = (metadata && typeof metadata === 'object') ? (metadata as Record<string, unknown>).erpnextPointsK : undefined;
  if (raw === undefined || raw === null) return null;
  const parsed = erpnextPointsKReference.safeParse(raw);
  if (!parsed.success) throw new PointsKSettlementError('REFERENCE_INVALID', parsed.error.issues.map(i => i.path.join('.')).join(','));
  return parsed.data;
}

// ---------------------------------------------------------------- item handlers

export type ItemHandlerName = 'points_k';
const HANDLERS: readonly ItemHandlerName[] = ['points_k'];

/**
 * ERPNEXT_ITEM_HANDLERS maps an ERPNext item_code to a business handler, for example
 * {"POINTS-K":"points_k"}. The item is configured, not coded: only points_k exists today.
 */
export function resolveItemHandler(itemCode: string, env: NodeJS.ProcessEnv = process.env): ItemHandlerName {
  let map: unknown;
  try { map = JSON.parse(env.ERPNEXT_ITEM_HANDLERS || '{}'); } catch { throw new PointsKSettlementError('HANDLER_NOT_CONFIGURED', 'ERPNEXT_ITEM_HANDLERS'); }
  const handler = map && typeof map === 'object' && Object.hasOwn(map, itemCode) ? (map as Record<string, unknown>)[itemCode] : undefined;
  if (typeof handler !== 'string' || !(HANDLERS as readonly string[]).includes(handler))
    throw new PointsKSettlementError('HANDLER_NOT_CONFIGURED', itemCode);
  return handler as ItemHandlerName;
}

// ---------------------------------------------------------------- ERPNext checks

/** ERPNext currency value -> minor units; refuses a fraction of a minor unit. */
export function erpMinor(value: unknown, currency: string): number {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const scaled = amount * 10 ** minorDigits(currency);
  const minor = Math.round(scaled);
  if (!Number.isFinite(amount) || minor <= 0 || !Number.isSafeInteger(minor) || Math.abs(scaled - minor) > 1e-6)
    throw new PointsKSettlementError('AMOUNT_MISMATCH', `invalid ${currency} amount`);
  return minor;
}

/** What the customer owes for a selling document: rounded total unless rounding is disabled. */
export function payableMinor(doc: any): number {
  const rounded = Number(doc?.rounded_total);
  return erpMinor(!doc?.disable_rounded_total && rounded > 0 ? rounded : doc?.grand_total, doc?.currency);
}

const mismatch = (what: string) => new PointsKSettlementError('DOCUMENT_MISMATCH', what);

/** The single item row of a Points K document; its quantity is a whole number of K. */
function pointsRow(doc: any, itemCode: string, label: string): any {
  const items: any[] = Array.isArray(doc?.items) ? doc.items : [];
  if (items.length !== 1 || items[0]?.item_code !== itemCode) throw mismatch(`${label}.items`);
  const row = items[0];
  const qty = Number(row.qty);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new PointsKSettlementError('QUANTITY_INVALID', `${label}.qty`);
  if (row.conversion_factor !== undefined && Number(row.conversion_factor) !== 1) throw new PointsKSettlementError('QUANTITY_INVALID', `${label}.conversion_factor`);
  return row;
}

export interface ErpnextChain { customer: any; quotation: any; salesOrder: any; paymentRequest: any }
export interface VerifiedChain { quantityK: number; netMinor: number }

/**
 * Checks the documents flux 1 and 2 created against the verified provider proof. The K
 * quantity comes from the Quotation item; the amount paid must equal what ERPNext asks.
 */
export function verifyErpnextChain(ref: ErpnextPointsKReference, docs: ErpnextChain,
  proof: { currency: string; confirmedMinor: number; keycloakId: string }): VerifiedChain {
  const { customer, quotation, salesOrder, paymentRequest } = docs;
  if (customer?.name !== ref.customer || customer.disabled) throw mismatch('Customer');
  if (customer.alias !== proof.keycloakId) throw new PointsKSettlementError('OWNER_MISMATCH', 'Customer.alias');

  if (quotation?.name !== ref.quotation || quotation.docstatus !== 1 || quotation.currency !== proof.currency) throw mismatch('Quotation');
  const qRow = pointsRow(quotation, ref.itemCode, 'Quotation');
  const quantityK = Number(qRow.qty);
  if (ref.quantityK !== undefined && ref.quantityK !== quantityK) throw new PointsKSettlementError('QUANTITY_INVALID', 'reference.quantityK');
  const netMinor = erpMinor(qRow.net_amount ?? quotation.net_total, proof.currency);
  if (payableMinor(quotation) !== proof.confirmedMinor) throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Quotation');

  if (salesOrder?.name !== ref.salesOrder || salesOrder.docstatus !== 1 || salesOrder.customer !== ref.customer
    || salesOrder.currency !== proof.currency) throw mismatch('Sales Order');
  const soRow = pointsRow(salesOrder, ref.itemCode, 'Sales Order');
  if (Number(soRow.qty) !== quantityK || soRow.prevdoc_docname !== ref.quotation) throw mismatch('Sales Order.items');
  if (payableMinor(salesOrder) !== proof.confirmedMinor) throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Sales Order');

  const pr = paymentRequest;
  if (pr?.name !== ref.paymentRequest || pr.docstatus !== 1 || pr.reference_doctype !== 'Sales Order'
    || pr.reference_name !== ref.salesOrder || pr.party !== ref.customer
    || (pr.party_type !== undefined && pr.party_type !== 'Customer')
    || (pr.payment_request_type !== undefined && pr.payment_request_type !== 'Inward')
    || pr.status === 'Cancelled' || pr.currency !== proof.currency) throw mismatch('Payment Request');
  if (erpMinor(pr.grand_total, pr.currency) !== proof.confirmedMinor) throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Payment Request');
  return { quantityK, netMinor };
}

export function verifySalesInvoice(doc: any, ref: ErpnextPointsKReference, s: { currency: string; confirmed_minor: number | string; quantity_k: number | string }) {
  if (!doc?.name || doc.customer !== ref.customer || doc.currency !== s.currency || doc.is_return
    || ![0, 1].includes(doc.docstatus)) throw mismatch('Sales Invoice');
  const row = pointsRow(doc, ref.itemCode, 'Sales Invoice');
  if (Number(row.qty) !== Number(s.quantity_k) || row.sales_order !== ref.salesOrder) throw mismatch('Sales Invoice.items');
  if (payableMinor(doc) !== Number(s.confirmed_minor)) throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Sales Invoice');
}

export function verifyPaymentEntry(doc: any, ref: ErpnextPointsKReference, s: { currency: string; confirmed_minor: number | string; provider_reference: string }, salesInvoice: string) {
  if (!doc?.name || doc.payment_type !== 'Receive' || doc.party_type !== 'Customer' || doc.party !== ref.customer
    || doc.reference_no !== s.provider_reference || ![0, 1].includes(doc.docstatus)) throw mismatch('Payment Entry');
  const confirmed = Number(s.confirmed_minor);
  if (erpMinor(doc.paid_amount, s.currency) !== confirmed) throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Payment Entry.paid_amount');
  const refs: any[] = Array.isArray(doc.references) ? doc.references : [];
  if (refs.length !== 1 || refs[0].reference_doctype !== 'Sales Invoice' || refs[0].reference_name !== salesInvoice
    || erpMinor(refs[0].allocated_amount, s.currency) !== confirmed) throw mismatch('Payment Entry.references');
}

/** A mapped document returned by an ERPNext mapper, ready to be inserted as a new draft. */
function draftFrom(mapped: any): Record<string, unknown> {
  const strip = (row: any) => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) =>
    !key.startsWith('__') && !['name', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'parent'].includes(key)));
  const doc = strip(mapped);
  for (const [key, value] of Object.entries(doc)) if (Array.isArray(value)) doc[key] = value.map(v => (v && typeof v === 'object' ? strip(v) : v));
  return doc;
}

async function erp<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof FrappeSiteError) {
      const detail = [error.httpStatus, error.excType].filter(Boolean).join(' ');
      throw new PointsKSettlementError(error.code === 'SITE_REJECTED' ? 'ERPNEXT_REJECTED' : 'ERPNEXT_UNAVAILABLE', detail);
    }
    throw error;
  }
}

async function uniqueNames(site: FrappeSite, doctype: string, filters: any[]): Promise<string[]> {
  const rows = await erp(() => site.list(doctype, filters, ['name'], 10));
  const names = [...new Set((rows ?? []).map((r: any) => r?.name).filter((n: unknown): n is string => typeof n === 'string'))];
  if (names.length > 1) throw new PointsKSettlementError('DUPLICATE_DOCUMENTS', `${doctype}: ${names.join(', ')}`);
  return names;
}

// ---------------------------------------------------------------- journal

interface SettlementRow {
  id: string; order_id: string; site: string; customer: string; quotation: string; sales_order: string;
  payment_request: string; item_code: string; handler: ItemHandlerName; currency: string; confirmed_minor: string;
  provider: 'stripe' | 'pawapay'; provider_reference: string; attempt_id: string; event_id: string;
  quantity_k: string | null; net_minor: string | null; status: 'payment_confirmed' | 'invoice_submitted' | 'payment_entry_submitted' | 'k_credited';
  sales_invoice: string | null; payment_entry: string | null; payment_request_status: string | null;
  financial_transaction_id: string | null;
}

async function step(db: Database, settlementId: string, name: string, outcome: 'done' | 'reused' | 'pending' | 'failed', detail: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO konektag.points_k_settlement_steps(settlement_id,step,outcome,detail) VALUES($1,$2,$3,$4::jsonb)`,
    [settlementId, name, outcome, JSON.stringify(detail)]);
}

/** Records the verified provider proof once; a replay must carry the same proof. */
async function recordProof(orderId: string, ref: ErpnextPointsKReference, handler: ItemHandlerName,
  providerReference: string, providerEventId: string): Promise<SettlementRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [order] } = await client.query(`SELECT id,currency FROM konektag.api_payment_orders WHERE id=$1 FOR UPDATE`, [orderId]);
    const { rows: [attempt] } = await client.query<{ id: string; provider: string; expected_amount: string; expected_currency: string; state: string }>(
      `SELECT id,provider,expected_amount,expected_currency,state FROM konektag.payment_provider_attempts
       WHERE source_type='api_payment' AND source_id::text=$1::text AND provider_reference=$2`, [orderId, providerReference]);
    if (!order || !attempt || attempt.state !== 'succeeded' || !['stripe', 'pawapay'].includes(attempt.provider)
      || attempt.expected_currency !== order.currency)
      throw new PointsKSettlementError('PROOF_MISSING', 'succeeded Stripe/pawaPay attempt');
    const { rows: [event] } = await client.query(
      `SELECT id FROM konektag.payment_provider_events WHERE id=$1 AND attempt_id=$2 AND failed_at IS NULL`, [providerEventId, attempt.id]);
    if (!event) throw new PointsKSettlementError('PROOF_MISSING', 'verified provider event');
    const inserted = await client.query<SettlementRow>(
      `INSERT INTO konektag.points_k_settlements(order_id,site,customer,quotation,sales_order,payment_request,item_code,handler,
         currency,confirmed_minor,provider,provider_reference,attempt_id,event_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(order_id) DO NOTHING RETURNING *`,
      [orderId, ref.site, ref.customer, ref.quotation, ref.salesOrder, ref.paymentRequest, ref.itemCode, handler,
        order.currency, attempt.expected_amount, attempt.provider, providerReference, attempt.id, providerEventId]);
    let row = inserted.rows[0];
    if (row) await step(client, row.id, 'payment_confirmed', 'done', { provider: attempt.provider, providerReference, confirmedMinor: Number(attempt.expected_amount), currency: order.currency });
    else {
      ({ rows: [row] } = await client.query<SettlementRow>(`SELECT * FROM konektag.points_k_settlements WHERE order_id=$1`, [orderId]));
      if (row.attempt_id !== attempt.id || row.site !== ref.site || row.payment_request !== ref.paymentRequest
        || row.sales_order !== ref.salesOrder || row.quotation !== ref.quotation || row.customer !== ref.customer || row.item_code !== ref.itemCode)
        throw new PointsKSettlementError('PROOF_CONFLICT', 'order already settled with other evidence');
    }
    await client.query('COMMIT');
    return row;
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Another order already claimed this Payment Request / Sales Order / provider reference.
    if (error?.code === '23505') throw new PointsKSettlementError('DOCUMENT_ALREADY_SETTLED', error.constraint ?? '');
    throw error;
  } finally { client.release(); }
}

const LEASE_SECONDS = 120;

async function acquireLease(id: string): Promise<string> {
  const token = crypto.randomUUID();
  const { rowCount } = await pool.query(
    `UPDATE konektag.points_k_settlements SET lease_token=$2,lease_until=now()+make_interval(secs=>$3),
       attempt_count=attempt_count+1,updated_at=now()
     WHERE id=$1 AND (lease_until IS NULL OR lease_until<now())`, [id, token, LEASE_SECONDS]);
  if (!rowCount) throw new PointsKSettlementError('SETTLEMENT_BUSY');
  return token;
}

/** A write is accepted only while this worker still holds the lease. */
async function leased(id: string, token: string, set: string, values: unknown[]): Promise<SettlementRow> {
  const { rows } = await pool.query<SettlementRow>(
    `UPDATE konektag.points_k_settlements SET ${set},updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING *`,
    [id, token, ...values]);
  if (!rows[0]) throw new PointsKSettlementError('SETTLEMENT_BUSY', 'lease lost');
  return rows[0];
}

// ---------------------------------------------------------------- ERPNext steps

async function ensureSalesInvoice(site: FrappeSite, ref: ErpnextPointsKReference, s: SettlementRow): Promise<{ name: string; reused: boolean }> {
  const [existing] = await uniqueNames(site, 'Sales Invoice', [['Sales Invoice Item', 'sales_order', '=', ref.salesOrder], ['docstatus', '<', 2]]);
  let name = existing;
  if (!name) {
    const mapped = await erp(() => site.call('erpnext.selling.doctype.sales_order.sales_order.make_sales_invoice', { source_name: ref.salesOrder }));
    const draft = draftFrom(mapped);
    verifySalesInvoice({ ...draft, name: 'draft', docstatus: 0 }, ref, s as any);
    name = (await erp(() => site.insert('Sales Invoice', draft)))?.name;
    if (!name) throw mismatch('Sales Invoice insert');
  }
  let doc = await erp(() => site.get('Sales Invoice', name));
  verifySalesInvoice(doc, ref, s as any);
  if (doc.docstatus === 0) {
    await erp(() => site.update('Sales Invoice', name, { docstatus: 1 }));
    doc = await erp(() => site.get('Sales Invoice', name));
  }
  if (doc.docstatus !== 1) throw mismatch('Sales Invoice not submitted');
  verifySalesInvoice(doc, ref, s as any);
  return { name, reused: Boolean(existing) };
}

async function ensurePaymentEntry(site: FrappeSite, ref: ErpnextPointsKReference, s: SettlementRow, paymentRequest: any): Promise<{ name: string; reused: boolean }> {
  const invoice = s.sales_invoice!;
  const [existing] = await uniqueNames(site, 'Payment Entry', [['reference_no', '=', s.provider_reference],
    ['party_type', '=', 'Customer'], ['party', '=', ref.customer], ['docstatus', '<', 2]]);
  let name = existing;
  if (!name) {
    // The invoice must still owe exactly what the provider collected: never pay it twice.
    const si = await erp(() => site.get('Sales Invoice', invoice));
    if (erpMinor(si.outstanding_amount, s.currency) !== Number(s.confirmed_minor))
      throw new PointsKSettlementError('AMOUNT_MISMATCH', 'Sales Invoice.outstanding_amount');
    const mapped = await erp(() => site.call('erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry', {
      dt: 'Sales Invoice', dn: invoice, ...(paymentRequest.payment_account ? { bank_account: paymentRequest.payment_account } : {}),
    }));
    const draft: any = draftFrom(mapped);
    draft.mode_of_payment = paymentRequest.mode_of_payment || draft.mode_of_payment;
    draft.reference_no = s.provider_reference;
    draft.reference_date = draft.posting_date || new Date().toISOString().slice(0, 10);
    draft.remarks = `Konektag ${s.provider} ${s.provider_reference} — Payment Request ${ref.paymentRequest}`;
    // Native link: on submit ERPNext reduces the Payment Request outstanding and marks it Paid.
    for (const row of draft.references ?? []) if (row.reference_name === invoice) row.payment_request = ref.paymentRequest;
    verifyPaymentEntry({ ...draft, name: 'draft', docstatus: 0 }, ref, s, invoice);
    name = (await erp(() => site.insert('Payment Entry', draft)))?.name;
    if (!name) throw mismatch('Payment Entry insert');
  }
  let doc = await erp(() => site.get('Payment Entry', name));
  verifyPaymentEntry(doc, ref, s, invoice);
  if (doc.docstatus === 0) {
    await erp(() => site.update('Payment Entry', name, { docstatus: 1 }));
    doc = await erp(() => site.get('Payment Entry', name));
  }
  if (doc.docstatus !== 1) throw mismatch('Payment Entry not submitted');
  verifyPaymentEntry(doc, ref, s, invoice);
  return { name, reused: Boolean(existing) };
}

export interface SettlementDeps { siteClient?: (key: string) => FrappeSite; env?: NodeJS.ProcessEnv }

export const pointsKV2Settlement = {
  /**
   * Accounting half, outside any PostgreSQL transaction (ERPNext calls). Returns null for an
   * order that is not a Points K V2 purchase, so every other circuit is untouched.
   */
  async prepare(orderId: string, providerReference: string | undefined, providerEventId: string | undefined,
    deps: SettlementDeps = {}): Promise<SettlementRow | null> {
    const { rows: [order] } = await pool.query(
      `SELECT o.id,o.order_purpose,o.order_metadata,u.keycloak_id FROM konektag.api_payment_orders o
       LEFT JOIN konektag.users u ON u.id=o.target_user_id WHERE o.id=$1`, [orderId]);
    if (!order) return null;
    const ref = readPointsKReference(order.order_metadata);
    if (!ref) return null;
    if (order.order_purpose !== 'wallet_recharge' || !order.keycloak_id) throw new PointsKSettlementError('REFERENCE_INVALID', 'order');
    if (!providerReference || !providerEventId) throw new PointsKSettlementError('PROOF_MISSING', 'provider reference and event');
    const handler = resolveItemHandler(ref.itemCode, deps.env);

    let s = await recordProof(orderId, ref, handler, providerReference, providerEventId);
    if (s.status === 'payment_entry_submitted' || s.status === 'k_credited') return s;

    const token = await acquireLease(s.id);
    try {
      const site = (deps.siteClient ?? frappeSite)(s.site);
      const [customer, quotation, salesOrder, paymentRequest] = await Promise.all([
        erp(() => site.get('Customer', ref.customer)), erp(() => site.get('Quotation', ref.quotation)),
        erp(() => site.get('Sales Order', ref.salesOrder)), erp(() => site.get('Payment Request', ref.paymentRequest))]);
      const verified = verifyErpnextChain(ref, { customer, quotation, salesOrder, paymentRequest },
        { currency: s.currency, confirmedMinor: Number(s.confirmed_minor), keycloakId: order.keycloak_id });
      if (s.quantity_k === null) {
        s = await leased(s.id, token, 'quantity_k=$3,net_minor=$4', [verified.quantityK, verified.netMinor]);
        await step(pool, s.id, 'documents_verified', 'done', { quantityK: verified.quantityK, netMinor: verified.netMinor });
      } else if (Number(s.quantity_k) !== verified.quantityK || Number(s.net_minor) !== verified.netMinor) {
        throw mismatch('Quotation changed after verification');
      }

      if (s.status === 'payment_confirmed') {
        const invoice = await ensureSalesInvoice(site, ref, s);
        s = await leased(s.id, token, `sales_invoice=$3,status='invoice_submitted'`, [invoice.name]);
        await step(pool, s.id, 'sales_invoice_submitted', invoice.reused ? 'reused' : 'done', { salesInvoice: invoice.name });
      }
      if (s.status === 'invoice_submitted') {
        const entry = await ensurePaymentEntry(site, ref, s, paymentRequest);
        s = await leased(s.id, token, `payment_entry=$3,status='payment_entry_submitted'`, [entry.name]);
        await step(pool, s.id, 'payment_entry_submitted', entry.reused ? 'reused' : 'done', { paymentEntry: entry.name });
      }
      // Evidence only: the status is ERPNext's own, never forced from here.
      const after = await erp(() => site.get('Payment Request', ref.paymentRequest));
      s = await leased(s.id, token, 'payment_request_status=$3', [after?.status ?? null]);
      await step(pool, s.id, 'payment_request_reflected', after?.status === 'Paid' ? 'done' : 'pending', { status: after?.status ?? null });
      return await leased(s.id, token, 'lease_token=NULL,lease_until=NULL,last_error=NULL', []);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown';
      await pool.query(`UPDATE konektag.points_k_settlements SET lease_token=NULL,lease_until=NULL,last_error=$3,updated_at=now()
        WHERE id=$1 AND lease_token=$2`, [s.id, token, message]).catch(() => undefined);
      await step(pool, s.id, 'processing', 'failed', { error: message }).catch(() => undefined);
      throw error;
    }
  },

  /**
   * Business half, inside the finalisation transaction of the order: the points_k handler
   * credits the Quotation K quantity, once ERPNext holds the invoice and its payment.
   */
  async credit(client: Database, order: { id: string; target_user_id: string | null; order_metadata: unknown;
    settlement_legal_entity_id: string | null; settlement_corridor_id: string | null; settlement_regulatory_profile_id: string | null },
    attempt: { id: string; provider: string }, providerReference: string): Promise<string> {
    const { rows: [s] } = await client.query<SettlementRow>(
      `SELECT * FROM konektag.points_k_settlements WHERE order_id=$1 FOR UPDATE`, [order.id]);
    if (!s || s.attempt_id !== attempt.id || s.provider_reference !== providerReference) throw new PointsKSettlementError('PROOF_CONFLICT', 'settlement evidence');
    if (s.status === 'k_credited' && s.financial_transaction_id) return s.financial_transaction_id;
    if (s.status !== 'payment_entry_submitted') throw new PointsKSettlementError('NOT_ACCOUNTED', s.status);
    if (s.handler !== 'points_k' || !order.target_user_id) throw new PointsKSettlementError('HANDLER_NOT_CONFIGURED', s.item_code);
    const quantityK = Number(s.quantity_k);
    const result = await confirmPointsAcquisition(client as PoolClient, {
      orderId: order.id, userId: order.target_user_id, provider: s.provider, providerReference,
      providerEventId: s.event_id, attemptId: s.attempt_id, confirmedMinor: Number(s.confirmed_minor), currency: s.currency,
      pointsQuantity: quantityK, lotValueMinor: Number(s.net_minor),
      legalEntityId: order.settlement_legal_entity_id!, corridorId: order.settlement_corridor_id!,
      regulatoryProfileId: order.settlement_regulatory_profile_id!,
    });
    await client.query(`UPDATE konektag.points_k_settlements SET status='k_credited',financial_transaction_id=$2,completed_at=now(),updated_at=now()
      WHERE id=$1`, [s.id, result.transactionId]);
    await step(client, s.id, 'k_credited', 'done', { handler: s.handler, quantityK, transactionId: result.transactionId });
    return result.transactionId;
  },
};
