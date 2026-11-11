// Points K V2, flux 3, against a real PostgreSQL (all migrations up to 234), the real Stripe and
// pawaPay webhook routes with genuinely signed requests, and a local HTTP ERPNext double that
// reproduces the native mappers (make_sales_order, make_payment_request, make_sales_invoice,
// get_payment_entry) and the ERPNext v15 Payment Request reflection on Payment Entry submit.
// The checkout order and its order_metadata.erpnextPointsK are produced by the real flux 2 code
// (createPointsKCheckout, PR #54). No provider, no Frappe site, never production.
// Run: DATABASE_URL=postgres://…/konektag_test NODE_ENV=development npx vitest run --config tests/integration/vitest.config.ts points-k-v2
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/konektag_test') throw new Error('DATABASE_URL must point at a throwaway database named konektag_test');

const STRIPE_WEBHOOK_SECRET = 'whsec_' + 'x'.repeat(32);
process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(24);
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_' + 'x'.repeat(24);
process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
process.env.PAWAPAY_API_TOKEN = 'sandbox-token';
process.env.ERPNEXT_ITEM_HANDLERS = JSON.stringify({ 'POINTS-K': 'points_k' });

// ------------------------------------------------------------------ ERPNext double
type Doc = Record<string, any>;
const docs: Record<string, Record<string, Doc>> = {};
const calls: string[] = [];
const faults: Record<string, number> = {};
let seq = 0;
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase(); // the database outlives a run
const table = (doctype: string) => (docs[doctype] ??= {});

function matches(doc: Doc, filters: any[]): boolean {
  return filters.every(f => {
    const [child, field, op, value] = f.length === 4 ? f : [null, ...f];
    const values = child ? (doc.items ?? doc.references ?? []).map((r: Doc) => r[field]) : [doc[field]];
    return values.some((v: unknown) => op === '=' ? v === value : op === '<' ? Number(v) < Number(value) : false);
  });
}
const payable = (d: Doc) => d.disable_rounded_total ? d.grand_total : d.rounded_total;

function erpnext(): Promise<void> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const target = new URL(req.url || '/', 'http://x');
      const path = decodeURIComponent(target.pathname);
      const body = raw ? JSON.parse(raw) : {};
      const key = `${req.method} ${path}`;
      calls.push(key);
      for (const [pattern, count] of Object.entries(faults)) if (count > 0 && key.includes(pattern)) { faults[pattern]--; return send(503, {}); }
      const resource = /^\/api\/resource\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (resource) {
        const [, doctype, name] = resource;
        if (req.method === 'GET' && name) return table(doctype)[name] ? send(200, { data: table(doctype)[name] }) : send(404, { exc_type: 'DoesNotExistError' });
        if (req.method === 'GET') {
          const filters = JSON.parse(target.searchParams.get('filters') || '[]');
          const fields: string[] = JSON.parse(target.searchParams.get('fields') || '["name"]');
          return send(200, { data: Object.values(table(doctype)).filter(d => matches(d, filters))
            .map(d => Object.fromEntries(fields.map(f => [f, d[f]]))) });
        }
        if (req.method === 'POST') {
          const prefix = { 'Sales Invoice': 'ACC-SINV-2026-', 'Sales Order': 'SAL-ORD-2026-' }[doctype] ?? 'ACC-PAY-2026-';
          const doc = { ...body, name: prefix + RUN + '-' + String(++seq).padStart(5, '0'), docstatus: 0 };
          table(doctype)[doc.name] = doc;
          return send(200, { data: doc });
        }
        if (req.method === 'PUT' && name && body.docstatus === 1) {
          const doc = table(doctype)[name];
          if (!doc || doc.docstatus !== 0) return send(417, { exc_type: 'ValidationError' });
          doc.docstatus = 1;
          if (doctype === 'Sales Invoice') doc.outstanding_amount = payable(doc);
          if (doctype === 'Payment Entry') for (const ref of doc.references) {
            table('Sales Invoice')[ref.reference_name].outstanding_amount -= ref.allocated_amount;
            const pr = ref.payment_request && table('Payment Request')[ref.payment_request];
            if (pr) { pr.outstanding_amount -= ref.allocated_amount; pr.status = pr.outstanding_amount <= 0 ? 'Paid' : 'Partially Paid'; }
          }
          return send(200, { data: doc });
        }
      }
      // ---- flux 1/2 natives used by createPointsKCheckout
      if (path === '/api/method/frappe.client.submit') {
        const doc = table(body.doc.doctype)[body.doc.name];
        if (!doc || doc.docstatus !== 0) return send(417, { exc_type: 'ValidationError' });
        doc.docstatus = 1;
        return send(200, { message: doc });
      }
      if (path === '/api/method/erpnext.selling.doctype.quotation.quotation.make_sales_order') {
        const q = table('Quotation')[body.source_name];
        const customer = Object.values(table('Customer')).find(c => c.lead_name === q.party_name);
        const { name: _n, docstatus: _d, quotation_to: _t, party_name: _p, ...rest } = q;
        return send(200, { message: { ...rest, doctype: 'Sales Order', __islocal: 1, name: 'new-sales-order-1', customer: customer!.name,
          order_type: 'Sales', transaction_date: '2026-11-11', items: q.items.map((r: Doc) => ({ ...r, name: 'new-row', prevdoc_docname: q.name })) } });
      }
      if (path === '/api/method/erpnext.accounts.doctype.payment_request.payment_request.make_payment_request') {
        const so = table('Sales Order')[body.dn];
        // No Payment Gateway Account: ERPNext leaves payment_account empty.
        const pr = { doctype: 'Payment Request', name: `ACC-PRQ-2026-${RUN}-${String(++seq).padStart(5, '0')}`, docstatus: body.submit_doc ? 1 : 0,
          status: 'Initiated', payment_request_type: 'Inward', reference_doctype: 'Sales Order', reference_name: so.name,
          party_type: 'Customer', party: so.customer, company: so.company, currency: so.currency, grand_total: payable(so),
          outstanding_amount: payable(so), mode_of_payment: body.mode_of_payment, payment_account: '' };
        table('Payment Request')[pr.name] = pr;
        return send(200, { message: pr });
      }
      if (path === '/api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account') {
        const account = { Stripe: 'Stripe - KTG', 'Mobile Money': 'Mobile Money - KTG-CG' }[body.mode_of_payment as string];
        return account ? send(200, { message: { account } }) : send(417, { exc_type: 'ValidationError' });
      }
      // ---- flux 3 natives
      if (path === '/api/method/erpnext.selling.doctype.sales_order.sales_order.make_sales_invoice') {
        const so = table('Sales Order')[body.source_name];
        if (Object.values(table('Sales Invoice')).some(si => si.docstatus === 1 && si.items.some((r: Doc) => r.sales_order === so.name)))
          return send(417, { exc_type: 'ValidationError' });
        const { name: _n, docstatus: _d, ...rest } = so;
        return send(200, { message: { ...rest, doctype: 'Sales Invoice', __islocal: 1, name: 'new-sales-invoice-1',
          items: so.items.map((r: Doc) => ({ ...r, name: 'new-row', sales_order: so.name, so_detail: r.name })) } });
      }
      if (path === '/api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry') {
        const si = table('Sales Invoice')[body.dn];
        if (!si || si.docstatus !== 1 || si.outstanding_amount <= 0) return send(417, { exc_type: 'ValidationError' });
        return send(200, { message: { doctype: 'Payment Entry', __islocal: 1, payment_type: 'Receive', party_type: 'Customer',
          party: si.customer, posting_date: '2026-11-11', paid_to: body.bank_account || 'Cash - KTG', paid_amount: si.outstanding_amount,
          received_amount: si.outstanding_amount, references: [{ reference_doctype: 'Sales Invoice', reference_name: si.name,
            outstanding_amount: si.outstanding_amount, allocated_amount: si.outstanding_amount }] } });
      }
      send(404, {});
    });
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    process.env.MARKETPLACE_FRAPPE_EUROPE_URL = `http://localhost:${(server.address() as AddressInfo).port}/`;
    process.env.MARKETPLACE_FRAPPE_EUROPE_API_KEY = 'k'; process.env.MARKETPLACE_FRAPPE_EUROPE_API_SECRET = 's';
    process.env.MARKETPLACE_FRAPPE_CONGO_URL = process.env.MARKETPLACE_FRAPPE_EUROPE_URL;
    process.env.MARKETPLACE_FRAPPE_CONGO_API_KEY = 'k'; process.env.MARKETPLACE_FRAPPE_CONGO_API_SECRET = 's';
    resolve();
  }));
}

// ------------------------------------------------------------------ pawaPay sandbox double (public signing key only)
const pawaKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
function pawapay(): Promise<void> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v2/public-key/http'
      ? [{ id: 'SANDBOX-KEY', key: pawaKeys.publicKey.export({ type: 'spki', format: 'pem' }) }] : {}));
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    process.env.PAWAPAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}
function signedPawaPayRequest(body: string): Request {
  const target = 'https://api.konektag.test/api/webhooks/pawapay/deposits';
  const headers: Record<string, string> = { 'content-type': 'application/json', 'signature-date': new Date().toISOString(),
    'content-digest': `sha-512=:${crypto.createHash('sha512').update(body).digest('base64')}:` };
  const now = Math.floor(Date.now() / 1000);
  const components = ['@method', '@authority', '@path', 'signature-date', 'content-digest', 'content-type'];
  const params = `;alg="ecdsa-p256-sha256";keyid="SANDBOX-KEY";created=${now};expires=${now + 60}`;
  const u = new URL(target);
  const value = (c: string) => c === '@method' ? 'POST' : c === '@authority' ? u.host : c === '@path' ? u.pathname : headers[c];
  const base = [...components.map(c => `"${c}": ${value(c)}`), `"@signature-params": (${components.map(c => `"${c}"`).join(' ')})${params}`].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(base), pawaKeys.privateKey).toString('base64');
  return new Request(target, { method: 'POST', body, headers: { ...headers,
    'signature-input': `sig-pp=(${components.map(c => `"${c}"`).join(' ')})${params}`, signature: `sig-pp=:${signature}:` } });
}

// ------------------------------------------------------------------ fixtures
const servers: http.Server[] = [];
let pool: any, stripeWebhook: any, pawapayWebhook: any, attempts: any, checkout: any, createPointsKCheckout: any;
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

async function buyer() {
  const id = crypto.randomUUID(); const keycloak = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state, legal_country)
    VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED', 'FR')`, [id, keycloak, 'b' + id.slice(0, 8), sha(id)]);
  const { resolvePointsOwner } = await import('../../src/application/services/pay/points-wallet-service.ts');
  return { id, keycloak, party: await resolvePointsOwner(pool, id) };
}
const balance = async (party: string) => Number((await pool.query('SELECT balance FROM konektag.points_balance($1)', [party])).rows[0].balance);

/** What flux 1 leaves in ERPNext: a Lead converted to a Customer (alias = Keycloak id) and a draft Quotation. */
table('Mode of Payment').Stripe = { name: 'Stripe', type: 'Bank', enabled: 1 };
table('Mode of Payment')['Mobile Money'] = { name: 'Mobile Money', type: 'Bank', enabled: 1 };
function quotation(label: string, user: { keycloak: string }, o: { currency: string; qty: number; rate: number; tax: number; grand: number; rounded?: number }) {
  const n = `${label}-${RUN}`;
  const customer = `CUST-${n}`, lead = `CRM-LEAD-${n}`, name = `SAL-QTN-${n}`;
  const company = o.currency === 'XAF' ? 'Konektag CG' : 'Konektag FR';
  table('Customer')[customer] = { doctype: 'Customer', name: customer, alias: user.keycloak, lead_name: lead, disabled: 0 };
  table('Quotation')[name] = { doctype: 'Quotation', name, docstatus: 0, quotation_to: 'Lead', party_name: lead, company, currency: o.currency,
    net_total: o.qty * o.rate, total_taxes_and_charges: o.tax, grand_total: o.grand, rounded_total: o.rounded ?? 0,
    disable_rounded_total: o.rounded === undefined ? 1 : 0,
    items: [{ name: 'qi-' + n, item_code: 'POINTS-K', qty: o.qty, conversion_factor: 1, rate: o.rate, net_amount: o.qty * o.rate, amount: o.qty * o.rate }] };
  return { customer, quotation: name };
}

const ROUTES = {
  FR: { residenceCountry: 'FR', paymentCountry: 'FR', slug: 'konektag-fr', site: 'EUROPE', timezone: 'Europe/Paris' },
  CG: { residenceCountry: 'CG', paymentCountry: 'CG', slug: 'konektag-cg', site: 'CONGO', timezone: 'Africa/Brazzaville' },
} as const;

/** Funding-time fields the existing checkout sets when the buyer picks a rail (not part of flux 2 or 3). */
async function fund(orderId: string, country: 'FR' | 'CG', rail: 'stripe' | 'mobile_money') {
  const entity = (await pool.query(`SELECT id FROM konektag.legal_entities WHERE code=$1`, [`KTG-${country}`])).rows[0].id;
  const profile = (await pool.query(`SELECT id FROM konektag.regulatory_profiles WHERE profile_code=$1`, [country === 'CG' ? 'ACQ-CG-MM' : 'ACQ-FR-STRIPE'])).rows[0].id;
  await pool.query(`UPDATE konektag.api_payment_orders SET state=$2, payment_method=$3, funding_state='external_started',
      settlement_legal_entity_id=$4, settlement_regulatory_profile_id=$5, settlement_corridor_id=$6, settlement_rail=$7, settlement_provider=$8
    WHERE id=$1`, [orderId, rail === 'stripe' ? 'processing' : 'awaiting_mobile_money', rail === 'stripe' ? 'card' : 'mobile_money',
    entity, profile, `${country}-${country}`, rail, rail === 'stripe' ? 'stripe' : 'pawapay']);
}

/** Flux 2 as shipped: Quotation submitted -> Sales Order -> Payment Request -> wallet_recharge order with erpnextPointsK. */
async function checkoutOrder(user: { id: string; keycloak: string }, country: 'FR' | 'CG', q: ReturnType<typeof quotation>, rail: 'stripe' | 'mobile_money') {
  const result = await createPointsKCheckout({ keycloakId: user.keycloak, userId: user.id, country, ...q,
    modeOfPayment: rail === 'stripe' ? 'Stripe' : 'Mobile Money' }, { route: async () => ROUTES[country] });
  await fund(result.order.id, country, rail);
  return { orderId: result.order.id as string, minor: result.amountMinor as number,
    refs: { customer: q.customer, quotation: result.quotation, salesOrder: result.salesOrder, paymentRequest: result.paymentRequest } };
}

/** A tampered order written directly, to prove flux 3 does not trust the order alone. */
async function rawOrder(user: { id: string }, refs: Record<string, string>, quantityK: number, o: { minor: number }) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.api_payment_orders (id, merchant_profile_id, order_purpose, business_purpose, target_user_id, environment,
      merchant_transaction_id, label, payer_identity, line_items, order_metadata, currency, subtotal_amount, tax_amount, fee_amount,
      cashback_amount, total_amount, wallet_available_amount, wallet_amount, external_amount, checkout_token_hash, beneficiary_type, payment_country)
    VALUES ($1, NULL, 'wallet_recharge', 'wallet_recharge', $2, 'live', $3, 'Points K', $4, '[]', $5::jsonb, 'EUR', $6, 0, 0, 0, $6, 0, 0, $6, $7, 'NETWORK', 'FR')`,
    [id, user.id, 'PK-' + id, 'user:' + user.id, JSON.stringify({ erpnextPointsK: { version: 1, site: 'EUROPE', itemCode: 'POINTS-K', quantityK, ...refs } }),
      o.minor, sha(id)]);
  await fund(id, 'FR', 'stripe');
  return id;
}

async function stripeAttempt(orderId: string, minor: number) {
  const pi = 'pi_' + crypto.randomBytes(8).toString('hex');
  await attempts.createOrUpdateStripeApiCheckoutAttempt({ orderId, paymentIntent: { id: pi, amount: minor, currency: 'eur', status: 'requires_payment_method' },
    metadata: { konektag_source_type: 'api_payment', konektag_source_id: orderId, konektag_operation_id: orderId } });
  return pi;
}
function stripeEvent(orderId: string, pi: string, amount: number, eventId = 'evt_' + crypto.randomBytes(8).toString('hex'), secret = STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: eventId, object: 'event', type: 'payment_intent.succeeded', data: { object: { id: pi, object: 'payment_intent',
    amount, currency: 'eur', status: 'succeeded', metadata: { konektag_source_type: 'api_payment', konektag_source_id: orderId, konektag_operation_id: orderId } } } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return stripeWebhook({ request: new Request('https://api.konektag.test/api/webhooks/stripe', { method: 'POST', body: payload, headers: { 'Stripe-Signature': header } }), params: {} });
}
const settlement = async (orderId: string) => (await pool.query(`SELECT * FROM konektag.points_k_settlements WHERE order_id=$1`, [orderId])).rows[0];
const steps = async (orderId: string) => (await pool.query(`SELECT s.step, s.outcome FROM konektag.points_k_settlement_steps s
  JOIN konektag.points_k_settlements p ON p.id=s.settlement_id WHERE p.order_id=$1 ORDER BY s.id`, [orderId])).rows.map((r: any) => `${r.step}:${r.outcome}`);
const count = (doctype: string, so: string) => Object.values(table(doctype)).filter(d =>
  doctype === 'Sales Invoice' ? d.items.some((r: Doc) => r.sales_order === so) : true).length;
const paymentEntriesFor = (invoice: string) => Object.values(table('Payment Entry')).filter(d => d.references.some((r: Doc) => r.reference_name === invoice));

beforeAll(async () => {
  await erpnext(); await pawapay();
  pool = (await import('../../src/infrastructure/database/pool.ts')).default;
  // Migrations seed KTG-CG as PENDING_APPROVAL; the K ledger only accepts an APPROVED owner.
  // Throwaway database only: on a real environment this approval is a finance decision.
  await pool.query(`UPDATE konektag.legal_entities SET status='APPROVED' WHERE code='KTG-CG'`);
  ({ POST: stripeWebhook } = await import('../../src/api/routes/webhooks/stripe.ts'));
  ({ POST: pawapayWebhook } = await import('../../src/api/routes/webhooks/pawapay/deposits.ts'));
  ({ paymentProviderAttemptService: attempts } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts'));
  ({ apiPaymentCheckoutService: checkout } = await import('../../src/application/services/pay/api-payment-checkout-service.ts'));
  ({ createPointsKCheckout } = await import('../../src/application/services/pay/points-k-checkout-service.ts'));
});
afterAll(async () => { for (const s of servers) s.close(); await pool?.end(); });
beforeEach(() => { calls.length = 0; for (const k of Object.keys(faults)) delete faults[k]; });

describe('Points K V2 flux 3 — Stripe (FR, EUR)', () => {
  it('credits exactly the Quotation K (83), not the TTC (99.60 EUR), after Sales Invoice and Payment Entry; replays are no-ops', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR1', user, { currency: 'EUR', qty: 83, rate: 1, tax: 16.6, grand: 99.6 }), 'stripe');
    expect(minor).toBe(9960);
    // Exact contract written by flux 2 (PR #54), read back from PostgreSQL.
    const { rows: [frozen] } = await pool.query(`SELECT order_metadata, currency, total_amount FROM konektag.api_payment_orders WHERE id=$1`, [orderId]);
    expect(frozen.currency).toBe('EUR');
    expect(Number(frozen.total_amount)).toBe(9960);
    expect(frozen.order_metadata).toEqual({ konektagSite: { slug: 'konektag-fr' }, erpnextPointsK: { version: 1, site: 'EUROPE', customer: refs.customer,
      quotation: refs.quotation, salesOrder: refs.salesOrder, paymentRequest: refs.paymentRequest, itemCode: 'POINTS-K', quantityK: 83 } });
    const pi = await stripeAttempt(orderId, 9960);

    const res = await stripeEvent(orderId, pi, 9960, `evt_fr1_${RUN}`);
    expect(res.status).toBe(200);
    const s = await settlement(orderId);
    expect(s).toMatchObject({ status: 'k_credited', quantity_k: '83', net_minor: '8300', confirmed_minor: '9960', currency: 'EUR',
      provider: 'stripe', provider_reference: pi, payment_request_status: 'Paid' });
    expect(await balance(user.party) - before).toBe(83);

    const si = table('Sales Invoice')[s.sales_invoice];
    expect(si).toMatchObject({ docstatus: 1, customer: refs.customer, outstanding_amount: 0 });
    expect(si.items[0]).toMatchObject({ item_code: 'POINTS-K', qty: 83, sales_order: refs.salesOrder });
    const pe = table('Payment Entry')[s.payment_entry];
    // paid_to comes from the Mode of Payment Account (the Payment Request has no gateway account).
    expect(pe).toMatchObject({ docstatus: 1, reference_no: pi, mode_of_payment: 'Stripe', paid_to: 'Stripe - KTG', paid_amount: 99.6 });
    expect(pe.references).toEqual([expect.objectContaining({ reference_doctype: 'Sales Invoice', reference_name: si.name, allocated_amount: 99.6, payment_request: refs.paymentRequest })]);
    expect(table('Payment Request')[refs.paymentRequest]).toMatchObject({ status: 'Paid', outstanding_amount: 0 });
    expect(await steps(orderId)).toEqual(['payment_confirmed:done', 'documents_verified:done', 'sales_invoice_submitted:done',
      'payment_entry_submitted:done', 'payment_request_reflected:done', 'k_credited:done']);
    const o = (await pool.query(`SELECT state, points_quantity, acquisition_status FROM konektag.api_payment_orders WHERE id=$1`, [orderId])).rows[0];
    expect(o).toMatchObject({ state: 'paid', points_quantity: '83', acquisition_status: 'completed' });

    // Same event delivered again, then a second event for the same PaymentIntent: no ERPNext write, no second credit.
    calls.length = 0;
    expect((await stripeEvent(orderId, pi, 9960, `evt_fr1_${RUN}`)).status).toBe(200);
    expect((await stripeEvent(orderId, pi, 9960, `evt_fr1_bis_${RUN}`)).status).toBe(200);
    expect(calls.filter(c => !c.startsWith('GET'))).toEqual([]);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(1);
    expect(paymentEntriesFor(si.name)).toHaveLength(1);
    expect(await balance(user.party) - before).toBe(83);
  });

  it('rejects an unsigned or wrongly signed Stripe event before any write', async () => {
    const user = await buyer();
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR2', user, { currency: 'EUR', qty: 10, rate: 1, tax: 2, grand: 12 }), 'stripe');
    expect(minor).toBe(1200);
    const pi = await stripeAttempt(orderId, 1200);
    calls.length = 0;
    expect((await stripeEvent(orderId, pi, 1200, undefined, 'whsec_forged_' + 'y'.repeat(20))).status).toBe(400);
    expect(await settlement(orderId)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('refuses a provider amount different from the Payment Request and never invoices nor credits', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs } = await checkoutOrder(user, 'FR', quotation('FR3', user, { currency: 'EUR', qty: 50, rate: 1, tax: 10, grand: 60 }), 'stripe');
    // Tampered order: it charges 50.00 EUR (the HT amount) while the Payment Request asks 60.00 EUR TTC.
    await pool.query(`UPDATE konektag.api_payment_orders SET subtotal_amount=5000,total_amount=5000,external_amount=5000 WHERE id=$1`, [orderId]);
    const pi = await stripeAttempt(orderId, 5000);
    expect((await stripeEvent(orderId, pi, 5000)).status).toBe(500);
    expect(await settlement(orderId)).toMatchObject({ status: 'payment_confirmed', quantity_k: null });
    expect((await settlement(orderId)).last_error).toMatch(/AMOUNT_MISMATCH/);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(0);
    expect(await balance(user.party)).toBe(before);
  });

  it('refuses a Customer whose alias is not the buyer Keycloak identity', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs } = await checkoutOrder(user, 'FR', quotation('FR4', user, { currency: 'EUR', qty: 5, rate: 1, tax: 1, grand: 6 }), 'stripe');
    // The Customer changed hands after the checkout (flux 2 checked the alias at that time).
    table('Customer')[refs.customer].alias = crypto.randomUUID();
    const pi = await stripeAttempt(orderId, 600);
    expect((await stripeEvent(orderId, pi, 600)).status).toBe(500);
    expect((await settlement(orderId)).last_error).toMatch(/OWNER_MISMATCH/);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(0);
    expect(await balance(user.party)).toBe(before);
  });

  it('resumes after a failure between the invoice and the payment without a second invoice', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR5', user, { currency: 'EUR', qty: 20, rate: 1, tax: 4, grand: 24 }), 'stripe');
    expect(minor).toBe(2400);
    const pi = await stripeAttempt(orderId, 2400);
    faults['get_payment_entry'] = 1;
    expect((await stripeEvent(orderId, pi, 2400, `evt_fr5_${RUN}`)).status).toBe(500);
    expect(await settlement(orderId)).toMatchObject({ status: 'invoice_submitted', payment_entry: null });
    expect(await balance(user.party)).toBe(before);
    expect((await stripeEvent(orderId, pi, 2400, `evt_fr5_${RUN}`)).status).toBe(200);
    const s = await settlement(orderId);
    expect(s.status).toBe('k_credited');
    expect(count('Sales Invoice', refs.salesOrder)).toBe(1);
    expect(paymentEntriesFor(s.sales_invoice)).toHaveLength(1);
    expect(await balance(user.party) - before).toBe(20);
  });

  it('finds an unsubmitted draft left by a crash instead of creating another document', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR6', user, { currency: 'EUR', qty: 7, rate: 1, tax: 1.4, grand: 8.4 }), 'stripe');
    expect(minor).toBe(840);
    const pi = await stripeAttempt(orderId, 840);
    faults['PUT /api/resource/Sales Invoice'] = 1; // inserted as draft, submit fails
    expect((await stripeEvent(orderId, pi, 840, `evt_fr6_${RUN}`)).status).toBe(500);
    expect(Object.values(table('Sales Invoice')).filter(d => d.items[0].sales_order === refs.salesOrder).map(d => d.docstatus)).toEqual([0]);
    expect((await stripeEvent(orderId, pi, 840, `evt_fr6_${RUN}`)).status).toBe(200);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(1);
    expect(await balance(user.party) - before).toBe(7);
  });

  it('resumes after a failure between accounting and the K credit through the recovery call, without ERPNext writes', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR7', user, { currency: 'EUR', qty: 30, rate: 1, tax: 6, grand: 36 }), 'stripe');
    expect(minor).toBe(3600);
    const pi = await stripeAttempt(orderId, 3600);
    await pool.query(`UPDATE konektag.parties SET is_active=false WHERE id=$1`, [user.party]);
    expect((await stripeEvent(orderId, pi, 3600, `evt_fr7_${RUN}`)).status).toBe(500);
    expect(await settlement(orderId)).toMatchObject({ status: 'payment_entry_submitted', financial_transaction_id: null });
    expect(await balance(user.party)).toBe(before);
    await pool.query(`UPDATE konektag.parties SET is_active=true WHERE id=$1`, [user.party]);

    // Same call and same selection as the outbox worker recovery loop (outbox-dispatcher.ts).
    const { rows: [recovery] } = await pool.query(`SELECT e.id AS event_id FROM konektag.payment_provider_events e
      JOIN konektag.payment_provider_attempts a ON a.id=e.attempt_id JOIN konektag.api_payment_orders o ON o.id::text=a.source_id::text
      WHERE e.failed_at IS NULL AND a.state='succeeded' AND o.order_purpose='wallet_recharge' AND o.id=$1
        AND NOT EXISTS (SELECT 1 FROM konektag.points_acquisitions pa WHERE pa.order_id=o.id AND pa.status='completed')`, [orderId]);
    expect(recovery).toBeDefined();
    calls.length = 0;
    await checkout.markFinalAndDispatch(orderId, 'card', pi, recovery.event_id);
    expect(calls).toEqual([]);
    expect((await settlement(orderId)).status).toBe('k_credited');
    expect(await balance(user.party) - before).toBe(30);
  });

  it('serialises concurrent deliveries: one invoice, one payment, one credit', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const { orderId, refs, minor } = await checkoutOrder(user, 'FR', quotation('FR8', user, { currency: 'EUR', qty: 12, rate: 1, tax: 2.4, grand: 14.4 }), 'stripe');
    expect(minor).toBe(1440);
    const pi = await stripeAttempt(orderId, 1440);
    const results = await Promise.all([stripeEvent(orderId, pi, 1440, `evt_fr8_a_${RUN}`), stripeEvent(orderId, pi, 1440, `evt_fr8_b_${RUN}`)]);
    if (results.some(r => r.status !== 200)) expect((await stripeEvent(orderId, pi, 1440, `evt_fr8_a_${RUN}`)).status).toBe(200);
    const s = await settlement(orderId);
    expect(s.status).toBe('k_credited');
    expect(count('Sales Invoice', refs.salesOrder)).toBe(1);
    expect(paymentEntriesFor(s.sales_invoice)).toHaveLength(1);
    expect(await balance(user.party) - before).toBe(12);
  });

  it('refuses to settle a second order pointing at an already settled Payment Request', async () => {
    const user = await buyer();
    const q = quotation('FR9', user, { currency: 'EUR', qty: 3, rate: 1, tax: 0.6, grand: 3.6 });
    const { orderId: first, refs } = await checkoutOrder(user, 'FR', q, 'stripe');
    expect((await stripeEvent(first, await stripeAttempt(first, 360), 360)).status).toBe(200);
    // Flux 2 replay: same Sales Order and Payment Request, same order, no new checkout token.
    const replay = await createPointsKCheckout({ keycloakId: user.keycloak, userId: user.id, country: 'FR', ...q, modeOfPayment: 'Stripe' },
      { route: async () => ROUTES.FR });
    expect(replay).toMatchObject({ salesOrder: refs.salesOrder, paymentRequest: refs.paymentRequest, checkoutToken: null, order: { id: first } });
    // A second order (another account) forged on the same, already settled, Payment Request.
    const other = await buyer(); const before = await balance(other.party);
    const second = await rawOrder(other, refs, 3, { minor: 360 });
    expect((await stripeEvent(second, await stripeAttempt(second, 360), 360)).status).toBe(500);
    expect(await settlement(second)).toBeUndefined();
    expect(await balance(other.party)).toBe(before);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(1);
  });
});

describe('Points K V2 flux 3 — pawaPay (CG, XAF)', () => {
  it('credits the Quotation K (10), not 7 730 XAF, from a signed pawaPay callback; a repeated callback changes nothing', async () => {
    const user = await buyer(); const before = await balance(user.party);
    // 10 K x 655 XAF HT + taxes configured on the site, rounded total 7 730 XAF.
    const { orderId, minor } = await checkoutOrder(user, 'CG', quotation('CG1', user, { currency: 'XAF', qty: 10, rate: 655, tax: 1178.95, grand: 7728.95, rounded: 7730 }), 'mobile_money');
    expect(minor).toBe(7730);
    const depositId = await attempts.createOrGetPawaPayApiCheckoutAttempt({ orderId, amount: 7730, currency: 'XAF', providerConfigurationKey: null });
    const body = JSON.stringify({ depositId, status: 'COMPLETED', amount: '7730.00', currency: 'XAF' });

    expect((await pawapayWebhook({ request: new Request('https://api.konektag.test/api/webhooks/pawapay/deposits', { method: 'POST', body,
      headers: { 'content-type': 'application/json' } }), params: {} })).status).toBe(400);
    expect(await settlement(orderId)).toBeUndefined();

    expect((await pawapayWebhook({ request: signedPawaPayRequest(body), params: {} })).status).toBe(200);
    const s = await settlement(orderId);
    expect(s).toMatchObject({ status: 'k_credited', quantity_k: '10', net_minor: '6550', confirmed_minor: '7730', currency: 'XAF', provider: 'pawapay', payment_request_status: 'Paid' });
    expect(table('Payment Entry')[s.payment_entry]).toMatchObject({ reference_no: depositId, mode_of_payment: 'Mobile Money', paid_to: 'Mobile Money - KTG-CG', paid_amount: 7730 });
    expect(await balance(user.party) - before).toBe(10);

    calls.length = 0;
    expect((await pawapayWebhook({ request: signedPawaPayRequest(body), params: {} })).status).toBe(200);
    expect(calls.filter(c => !c.startsWith('GET'))).toEqual([]);
    expect(await balance(user.party) - before).toBe(10);
  });
});
