// Points K V2, flux 3, against a real PostgreSQL (all migrations up to 234), the real Stripe and
// pawaPay webhook routes with genuinely signed requests, and a local HTTP ERPNext double that
// reproduces the native mappers (make_sales_invoice, get_payment_entry) and the ERPNext v15
// Payment Request reflection on Payment Entry submit. No provider, no Frappe site, never production.
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
          return send(200, { data: Object.values(table(doctype)).filter(d => matches(d, filters)).map(d => ({ name: d.name })) });
        }
        if (req.method === 'POST') {
          const prefix = doctype === 'Sales Invoice' ? 'ACC-SINV-2026-' : 'ACC-PAY-2026-';
          const doc = { ...body, name: prefix + String(++seq).padStart(5, '0'), docstatus: 0 };
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
let pool: any, stripeWebhook: any, pawapayWebhook: any, attempts: any, checkout: any;
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

async function buyer() {
  const id = crypto.randomUUID(); const keycloak = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state, legal_country)
    VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED', 'FR')`, [id, keycloak, 'b' + id.slice(0, 8), sha(id)]);
  const { resolvePointsOwner } = await import('../../src/application/services/pay/points-wallet-service.ts');
  return { id, keycloak, party: await resolvePointsOwner(pool, id) };
}
const balance = async (party: string) => Number((await pool.query('SELECT balance FROM konektag.points_balance($1)', [party])).rows[0].balance);

/** ERPNext chain as flux 1 and 2 leave it: submitted Quotation -> Sales Order -> Payment Request. */
const RUN = crypto.randomBytes(3).toString('hex').toUpperCase(); // the database outlives a run
function chain(label: string, user: { keycloak: string }, o: { currency: string; qty: number; rate: number; tax: number; grand: number; rounded?: number }) {
  const n = `${label}-${RUN}`;
  const customer = `CUST-${n}`, quotation = `SAL-QTN-${n}`, salesOrder = `SAL-ORD-${n}`, paymentRequest = `ACC-PRQ-${n}`;
  const totals = { currency: o.currency, net_total: o.qty * o.rate, total_taxes_and_charges: o.tax, grand_total: o.grand,
    rounded_total: o.rounded ?? 0, disable_rounded_total: o.rounded === undefined ? 1 : 0 };
  const item = { item_code: 'POINTS-K', qty: o.qty, conversion_factor: 1, rate: o.rate, net_amount: o.qty * o.rate, amount: o.qty * o.rate };
  table('Customer')[customer] = { name: customer, alias: user.keycloak, disabled: 0 };
  table('Quotation')[quotation] = { name: quotation, docstatus: 1, quotation_to: 'Lead', party_name: `CRM-LEAD-${n}`, ...totals, items: [{ ...item, name: 'qi-' + n }] };
  table('Sales Order')[salesOrder] = { name: salesOrder, docstatus: 1, customer, ...totals, items: [{ ...item, name: 'soi-' + n, prevdoc_docname: quotation }] };
  table('Payment Request')[paymentRequest] = { name: paymentRequest, docstatus: 1, status: 'Initiated', payment_request_type: 'Inward',
    reference_doctype: 'Sales Order', reference_name: salesOrder, party_type: 'Customer', party: customer, currency: o.currency,
    grand_total: o.rounded ?? o.grand, outstanding_amount: o.rounded ?? o.grand, mode_of_payment: o.currency === 'XAF' ? 'Mobile Money' : 'Stripe',
    payment_account: o.currency === 'XAF' ? 'Mobile Money - KTG-CG' : 'Stripe - KTG' };
  return { customer, quotation, salesOrder, paymentRequest };
}

/** The checkout flux 2 freezes: an existing wallet_recharge order carrying the ERPNext references. */
async function order(user: { id: string }, site: string, refs: ReturnType<typeof chain>, o: { currency: string; minor: number; rail: 'stripe' | 'mobile_money' }) {
  const id = crypto.randomUUID();
  const entity = (await pool.query(`SELECT id FROM konektag.legal_entities WHERE code=$1`, [o.currency === 'XAF' ? 'KTG-CG' : 'KTG-FR'])).rows[0].id;
  const profile = (await pool.query(`SELECT id FROM konektag.regulatory_profiles WHERE profile_code=$1`, [o.currency === 'XAF' ? 'ACQ-CG-MM' : 'ACQ-FR-STRIPE'])).rows[0].id;
  await pool.query(`INSERT INTO konektag.api_payment_orders (id, merchant_profile_id, order_purpose, business_purpose, target_user_id, environment,
      merchant_transaction_id, label, payer_identity, line_items, order_metadata, currency, subtotal_amount, tax_amount, fee_amount,
      cashback_amount, total_amount, wallet_available_amount, wallet_amount, external_amount, checkout_token_hash, beneficiary_type,
      payment_country, amount_unit, state, payment_method, funding_state, settlement_legal_entity_id, settlement_regulatory_profile_id,
      settlement_corridor_id, settlement_rail, settlement_provider)
    VALUES ($1, NULL, 'wallet_recharge', 'wallet_recharge', $2, 'live', $3, 'Points K', $4, '[]', $5::jsonb, $6, $7, 0, 0, 0, $7, 0, 0, $7,
      $8, 'NETWORK', $9, 'MINOR', $10, $11, 'external_started', $12, $13, $14, $15, $16)`,
    [id, user.id, 'PK-' + id, 'user:' + user.id, JSON.stringify({ erpnextPointsK: { version: 1, site, itemCode: 'POINTS-K', ...refs } }),
      o.currency, o.minor, sha(id), o.currency === 'XAF' ? 'CG' : 'FR', o.rail === 'stripe' ? 'processing' : 'awaiting_mobile_money',
      o.rail === 'stripe' ? 'card' : 'mobile_money', entity, profile, o.currency === 'XAF' ? 'CG-CG' : 'FR-FR', o.rail, o.rail === 'stripe' ? 'stripe' : 'pawapay']);
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
});
afterAll(async () => { for (const s of servers) s.close(); await pool?.end(); });
beforeEach(() => { calls.length = 0; for (const k of Object.keys(faults)) delete faults[k]; });

describe('Points K V2 flux 3 — Stripe (FR, EUR)', () => {
  it('credits exactly the Quotation K (83), not the TTC (99.60 EUR), after Sales Invoice and Payment Entry; replays are no-ops', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const refs = chain('FR1', user, { currency: 'EUR', qty: 83, rate: 1, tax: 16.6, grand: 99.6 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 9960, rail: 'stripe' });
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
    const refs = chain('FR2', user, { currency: 'EUR', qty: 10, rate: 1, tax: 2, grand: 12 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 1200, rail: 'stripe' });
    const pi = await stripeAttempt(orderId, 1200);
    expect((await stripeEvent(orderId, pi, 1200, undefined, 'whsec_forged_' + 'y'.repeat(20))).status).toBe(400);
    expect(await settlement(orderId)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('refuses a provider amount different from the Payment Request and never invoices nor credits', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const refs = chain('FR3', user, { currency: 'EUR', qty: 50, rate: 1, tax: 10, grand: 60 });
    // The checkout charged 50.00 EUR (the HT amount) while ERPNext asks 60.00 EUR TTC.
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 5000, rail: 'stripe' });
    const pi = await stripeAttempt(orderId, 5000);
    expect((await stripeEvent(orderId, pi, 5000)).status).toBe(500);
    expect(await settlement(orderId)).toMatchObject({ status: 'payment_confirmed', quantity_k: null });
    expect((await settlement(orderId)).last_error).toMatch(/AMOUNT_MISMATCH/);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(0);
    expect(await balance(user.party)).toBe(before);
  });

  it('refuses a Customer whose alias is not the buyer Keycloak identity', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const refs = chain('FR4', user, { currency: 'EUR', qty: 5, rate: 1, tax: 1, grand: 6 });
    table('Customer')[refs.customer].alias = crypto.randomUUID();
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 600, rail: 'stripe' });
    const pi = await stripeAttempt(orderId, 600);
    expect((await stripeEvent(orderId, pi, 600)).status).toBe(500);
    expect((await settlement(orderId)).last_error).toMatch(/OWNER_MISMATCH/);
    expect(count('Sales Invoice', refs.salesOrder)).toBe(0);
    expect(await balance(user.party)).toBe(before);
  });

  it('resumes after a failure between the invoice and the payment without a second invoice', async () => {
    const user = await buyer(); const before = await balance(user.party);
    const refs = chain('FR5', user, { currency: 'EUR', qty: 20, rate: 1, tax: 4, grand: 24 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 2400, rail: 'stripe' });
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
    const refs = chain('FR6', user, { currency: 'EUR', qty: 7, rate: 1, tax: 1.4, grand: 8.4 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 840, rail: 'stripe' });
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
    const refs = chain('FR7', user, { currency: 'EUR', qty: 30, rate: 1, tax: 6, grand: 36 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 3600, rail: 'stripe' });
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
    const refs = chain('FR8', user, { currency: 'EUR', qty: 12, rate: 1, tax: 2.4, grand: 14.4 });
    const orderId = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 1440, rail: 'stripe' });
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
    const refs = chain('FR9', user, { currency: 'EUR', qty: 3, rate: 1, tax: 0.6, grand: 3.6 });
    const first = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 360, rail: 'stripe' });
    expect((await stripeEvent(first, await stripeAttempt(first, 360), 360)).status).toBe(200);
    const before = await balance(user.party);
    const second = await order(user, 'EUROPE', refs, { currency: 'EUR', minor: 360, rail: 'stripe' });
    expect((await stripeEvent(second, await stripeAttempt(second, 360), 360)).status).toBe(500);
    expect(await settlement(second)).toBeUndefined();
    expect(await balance(user.party)).toBe(before);
  });
});

describe('Points K V2 flux 3 — pawaPay (CG, XAF)', () => {
  it('credits the Quotation K (10), not 7 730 XAF, from a signed pawaPay callback; a repeated callback changes nothing', async () => {
    const user = await buyer(); const before = await balance(user.party);
    // 10 K x 655 XAF HT + taxes configured on the site, rounded total 7 730 XAF.
    const refs = chain('CG1', user, { currency: 'XAF', qty: 10, rate: 655, tax: 1178.95, grand: 7728.95, rounded: 7730 });
    const orderId = await order(user, 'CONGO', refs, { currency: 'XAF', minor: 7730, rail: 'mobile_money' });
    const depositId = await attempts.createOrGetPawaPayApiCheckoutAttempt({ orderId, amount: 7730, currency: 'XAF', providerConfigurationKey: null });
    const body = JSON.stringify({ depositId, status: 'COMPLETED', amount: '7730.00', currency: 'XAF' });

    expect((await pawapayWebhook({ request: new Request('https://api.konektag.test/api/webhooks/pawapay/deposits', { method: 'POST', body,
      headers: { 'content-type': 'application/json' } }), params: {} })).status).toBe(400);
    expect(await settlement(orderId)).toBeUndefined();

    expect((await pawapayWebhook({ request: signedPawaPayRequest(body), params: {} })).status).toBe(200);
    const s = await settlement(orderId);
    expect(s).toMatchObject({ status: 'k_credited', quantity_k: '10', net_minor: '6550', confirmed_minor: '7730', currency: 'XAF', provider: 'pawapay', payment_request_status: 'Paid' });
    expect(table('Payment Entry')[s.payment_entry]).toMatchObject({ reference_no: depositId, mode_of_payment: 'Mobile Money', paid_amount: 7730 });
    expect(await balance(user.party) - before).toBe(10);

    calls.length = 0;
    expect((await pawapayWebhook({ request: signedPawaPayRequest(body), params: {} })).status).toBe(200);
    expect(calls.filter(c => !c.startsWith('GET'))).toEqual([]);
    expect(await balance(user.party) - before).toBe(10);
  });
});
