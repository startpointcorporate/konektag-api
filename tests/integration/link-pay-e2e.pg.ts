// Link Pay end to end: real API code on a throwaway PostgreSQL, two real disposable Frappe sites
// (congo.test = network, resto.test = merchant) running konektag_360. Driven by
// konektag_360/scripts/validate-link-pay-e2e.sh, which prepares the sites and sets E2E_*. Never production.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const env = process.env;
if (!env.DATABASE_URL || new URL(env.DATABASE_URL).pathname !== '/konektag_test' || !env.E2E_BENCH)
  throw new Error('Run through konektag_360/scripts/validate-link-pay-e2e.sh on a throwaway database');
const prepared = { CONGO: JSON.parse(env.E2E_CONGO!), RESTODEMO: JSON.parse(env.E2E_RESTODEMO!) };
const hosts = { CONGO: 'congo.test', RESTODEMO: 'resto.test' } as const;
type Site = keyof typeof hosts;
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

// Frappe sites reached through localhost HTTP relays. 'webhooks-down' makes only the webhook
// endpoint unavailable (503), as a site whose worker is down while its reads still answer.
const relays: Record<string, { server: http.Server; port: number; mode: 'up' | 'down' | 'webhooks-down' }> = {};
function relay(site: Site, target: string) {
  const [host, port] = target.split(':');
  const entry = { server: http.createServer((req, res) => {
    if (entry.mode === 'down' || (entry.mode === 'webhooks-down' && req.url?.includes('link_pay.webhook.receive'))) {
      res.writeHead(503); return res.end();
    }
    const upstream = http.request({ host, port: Number(port), method: req.method, path: req.url, headers: req.headers }, answer => {
      res.writeHead(answer.statusCode || 502, answer.headers); answer.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }), port: 0, mode: 'up' as 'up' | 'down' | 'webhooks-down' };
  relays[site] = entry;
  return new Promise<void>(resolve => entry.server.listen(0, '127.0.0.1', () => { entry.port = (entry.server.address() as AddressInfo).port; resolve(); }));
}

// Asynchronous: the API served by this process must keep answering the Frappe sites meanwhile.
const run = promisify(execFile);
const bench = async (site: Site, fn: string, kwargs: Record<string, unknown>) => {
  try {
    const { stdout } = await run('docker', ['exec', env.E2E_BENCH!, 'bash', '-lc',
      `cd /home/frappe/frappe-bench && bench --site ${hosts[site]} execute konektag_360.tests.link_pay_e2e.${fn} --kwargs '${JSON.stringify(kwargs)}'`],
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)!);
  } catch (error: any) {
    throw new Error(`${site} ${fn}: ${String(error.stderr || error.stdout || error.message).split('\n').filter(Boolean).slice(-6).join(' | ')}`);
  }
};

let pool: any, routes: any, pay: any, siteWebhookService: any, apiServer: http.Server, apiUrl = '';
let pawaPay: http.Server, stripeApi: http.Server, regularizationRoute: any, regularizationUrl = '', apiDown = false;
const pawaPayDeposits: Record<string, unknown> = {};
const stripeIntents: Record<string, unknown> = {};
const waitFor = async (check: () => Promise<boolean>, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await check()) return;
  const rows = (await pool.query(`SELECT target_site, status, attempts, last_error, left(response_body, 300) body
    FROM konektag.link_pay_site_webhooks ORDER BY created_at DESC LIMIT 4`)).rows;
  throw new Error('timeout ' + JSON.stringify(rows));
};
// Invoice numbers repeat across sites: always scope by the beneficiary site.
const deliveries = async (invoice: string, site: Site) => Object.fromEntries((await pool.query(
  `SELECT w.target_site, w.status FROM konektag.link_pay_site_webhooks w JOIN konektag.link_pay_network_transactions t
   ON t.id = w.transaction_id WHERE t.invoice = $1 AND t.beneficiary_site = $2`, [invoice, site])).rows.map((r: any) => [r.target_site, r.status]));

async function payer(country: string | null = null) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state, legal_country)
    VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED', $5)`, [id, crypto.randomUUID(), 'p' + id.slice(0, 8), sha(id), country]);
  const { resolvePointsOwner } = await import('../../src/application/services/pay/points-wallet-service.ts');
  const party = await resolvePointsOwner(pool, id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`INSERT INTO konektag.k_wallet_entries (party_id, operation_id, operation_type, direction, quantity_k, source_type, source_id)
      VALUES ($1, gen_random_uuid(), 'adjustment', 'credit', 1000000, 'test', 'fixture')`, [party]);
    await client.query('COMMIT');
  } finally { client.release(); }
  return { id, email: id + '@example.test', party };
}
const payLink = async (slug: string) => {
  const response: Response = await pay({ locals: { user: await payer() },
    request: new Request('http://x/api/pay/pay-link', { method: 'POST', body: JSON.stringify({ slug }) }) } as any);
  if (response.status !== 201) console.error('pay-link', response.status, await response.clone().text());
  return response;
};

beforeAll(async () => {
  await relay('CONGO', env.E2E_CONGO_TARGET!); await relay('RESTODEMO', env.E2E_RESTO_TARGET!);
  const sites: Record<string, unknown> = {};
  for (const site of ['CONGO', 'RESTODEMO'] as Site[]) {
    env[`MARKETPLACE_FRAPPE_${site}_URL`] = `http://localhost:${relays[site].port}/`;
    env[`MARKETPLACE_FRAPPE_${site}_API_KEY`] = prepared[site].api_key;
    env[`MARKETPLACE_FRAPPE_${site}_API_SECRET`] = prepared[site].api_secret;
    sites[site] = { tokenSha256: sha(env[`E2E_${site}_TOKEN`]!), webhookSecret: env[`E2E_${site}_SECRET`], ...(site === 'CONGO' ? { network: true } : {}) };
  }
  env.LINK_PAY_FRAPPE_SITES = JSON.stringify(sites);
  // Points K recharges of CG residents are followed on the Congo site (routed slug konektag-cg).
  // Two Network sites: Congo (konektag-cg, PawaPay XAF) and resto.test playing Europe (konektag-fr, Stripe EUR;
  // XAF is not a card currency).
  env.MARKETPLACE_TRANSACTION_MERCHANTS = JSON.stringify({ 'konektag-cg': { site: 'CONGO' }, 'konektag-fr': { site: 'RESTODEMO' } });
  // PawaPay replaced by a local server answering the reconciliation polls.
  pawaPay = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url || '').split('/').pop() || '');
    const deposit = pawaPayDeposits[id];
    if (deposit === 'ERROR') { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(deposit ? { status: 'FOUND', data: deposit } : { status: 'NOT_FOUND' }));
  });
  await new Promise<void>(r => pawaPay.listen(0, '127.0.0.1', () => r()));
  env.PAWAPAY_API_URL = `http://127.0.0.1:${(pawaPay.address() as AddressInfo).port}`;
  env.PAWAPAY_API_TOKEN = 'e2e-only';
  // The real outbox worker loads the encryption service: a throwaway key for this database only.
  env.DATA_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString('base64');
  pool = (await import('../../src/infrastructure/database/pool.ts')).default;
  // Link Pay must work without konektag.merchant_profiles: remove it from this throwaway database.
  await pool.query('DROP TABLE IF EXISTS konektag.merchant_profiles CASCADE');
  expect((await pool.query(`SELECT to_regclass('konektag.merchant_profiles') AS t`)).rows[0].t).toBeNull();
  routes = await import('../../src/api/routes/integrations/frappe/payment-links.ts');
  regularizationRoute = await import('../../src/api/routes/integrations/frappe/network-operations.ts');
  // Stripe replaced by a local server for the on-demand verification (PaymentIntent retrieval).
  stripeApi = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url || '').split('?')[0].split('/').pop() || '');
    const intent = stripeIntents[id];
    res.writeHead(intent ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(intent ?? { error: { type: 'invalid_request_error', message: 'No such payment_intent' } }));
  });
  await new Promise<void>(r => stripeApi.listen(0, '127.0.0.1', () => r()));
  env.KONEKTAG_STRIPE_API_BASE = `http://127.0.0.1:${(stripeApi.address() as AddressInfo).port}`;
  env.KTG_FR_STRIPE_TEST_SECRET_KEY = 'sk_test_e2e_only';
  env.KTG_FR_STRIPE_TEST_PUBLISHABLE_KEY = 'pk_test_e2e_only';
  env.KTG_FR_STRIPE_TEST_WEBHOOK_SECRET = 'whsec_e2e_only_0123456789';
  env.KONEKTAG_INTEGRATION_SECRET ??= crypto.randomBytes(32).toString('hex');
  ({ POST: pay } = await import('../../src/api/routes/pay/pay-link.ts'));
  ({ siteWebhookService } = await import('../../src/application/link-pay/site-webhook-service.ts'));
  await pool.query(`INSERT INTO konektag.exchange_rates (from_currency, to_currency, rate, points_k_status, valid_from, valid_to,
      points_k_matrix_version, points_k_approval_source)
    SELECT 'XAF', 'EUR', 0.0015243902439024, 'APPROVED', '2026-01-01', '2027-12-31', 7, 'E2E'
    WHERE NOT EXISTS (SELECT 1 FROM konektag.exchange_rates WHERE from_currency='XAF' AND points_k_status='APPROVED')`);
  // Warm both Frappe workers (first request loads the app) before timing-sensitive calls.
  for (const site of ['CONGO', 'RESTODEMO'] as Site[])
    await fetch(`http://localhost:${relays[site].port}/api/method/ping`).then(r => r.text()).catch(() => undefined);
  // The API integration route served over HTTP for the Frappe sites.
  apiServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://api');
    const request = new Request(url, { method: req.method, headers: req.headers as any,
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    if (apiDown) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"DOWN"}'); }
    const handler = url.pathname.endsWith('/network-operations') ? regularizationRoute : routes;
    const response: Response = await handler[req.method as 'GET' | 'POST']({ request, url, locals: {} } as any);
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  });
  await new Promise<void>(r => apiServer.listen(0, '0.0.0.0', () => r()));
  apiUrl = `http://${env.E2E_GATEWAY}:${(apiServer.address() as AddressInfo).port}/api/integrations/frappe/payment-links`;
  regularizationUrl = apiUrl.replace('/payment-links', '/network-operations');
}, 60000);
afterAll(async () => { apiServer?.close(); pawaPay?.close(); stripeApi?.close(); Object.values(relays).forEach(r => r.server.close()); await pool?.end(); });

describe('Link Pay end to end, real API and real Frappe sites', () => {
  it('merchant invoice: Congo records the split first, the merchant invoice is settled once, a payout clears the balance', async () => {
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 6500 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    expect(issued).toMatchObject({ state: 'Generated' });
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    const order = (await pool.query(`SELECT w.target_site FROM konektag.link_pay_site_webhooks w JOIN konektag.link_pay_network_transactions t
      ON t.id = w.transaction_id WHERE t.invoice = $1 AND t.beneficiary_site = 'RESTODEMO' ORDER BY w.delivered_at`, [invoice])).rows.map((r: any) => r.target_site);
    expect(order).toEqual(['CONGO', 'RESTODEMO']);
    const resto = (await bench('RESTODEMO', 'state', { invoice }));
    expect(resto).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid', transactions: [] });
    expect(resto.entries).toHaveLength(1);
    expect(resto.entries[0]).toMatchObject({ paid_amount: 6500, docstatus: 1 });
    let congo = (await bench('CONGO', 'state', {}));
    expect(congo.transactions.filter((t: any) => t.beneficiary === 'RESTODEMO')).toMatchObject([
      { third_party: 1, currency: 'XAF', gross_amount: 6500, fee_amount: 163, net_amount: 6337 }]);
    expect(congo.balances.find((b: any) => b.beneficiary === 'RESTODEMO')).toMatchObject({ net: 6337, paid: 0, remaining: 6337 });

    // Replayed webhooks (both sites) and the worker: no second transaction, Payment Entry or debit.
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET status='failed', next_attempt_at=now() WHERE transaction_id IN
      (SELECT id FROM konektag.link_pay_network_transactions WHERE invoice=$1 AND beneficiary_site='RESTODEMO')`, [invoice]);
    await siteWebhookService.processDue();
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    expect((await bench('RESTODEMO', 'state', { invoice })).entries).toHaveLength(1);
    expect((await bench('CONGO', 'state', {})).transactions.filter((t: any) => t.beneficiary === 'RESTODEMO')).toHaveLength(1);
    expect(Number((await pool.query(`SELECT count(*) n FROM konektag.link_pay_network_transactions WHERE invoice=$1 AND beneficiary_site='RESTODEMO'`, [invoice])).rows[0].n)).toBe(1);

    expect((await bench('CONGO', 'payout', { beneficiary: 'RESTODEMO', currency: 'XAF', reference: 'MTN-E2E-1' }))).toMatchObject({ total: 6337, covered: 1 });
    congo = (await bench('CONGO', 'state', {}));
    expect(congo.balances.find((b: any) => b.beneficiary === 'RESTODEMO')).toMatchObject({ net: 6337, paid: 6337, remaining: 0 });
  }, 120000);

  it('360° invoice issued by Congo: one webhook, Congo invoice settled, nothing owed to a merchant', async () => {
    const invoice = (await bench('CONGO', 'new_invoice', { like: prepared.CONGO.invoice, amount: 4000 })).invoice;
    const issued = (await bench('CONGO', 'generate', { invoice, user: prepared.CONGO.user, api_url: apiUrl }));
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'CONGO')) === JSON.stringify({ CONGO: 'delivered' }));
    const congo = (await bench('CONGO', 'state', { invoice }));
    expect(congo).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
    expect(congo.entries).toHaveLength(1);
    expect(congo.balances.find((b: any) => b.beneficiary === 'CONGO')).toMatchObject({ third_party: 0, remaining: 0 });
  }, 120000);

  it('network unavailable: the merchant is not notified until Congo has recorded the payment', async () => {
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 1000 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    // Network down at payment: the approval cannot be read again, the client is not debited.
    relays.CONGO.mode = 'down';
    expect((await payLink(issued.slug)).status).toBe(503);
    expect(Number((await pool.query(`SELECT count(*) n FROM konektag.checkout_intents WHERE public_id=$1 AND status='ISSUED'`, [issued.slug])).rows[0].n)).toBe(1);
    // Network webhook endpoint down after payment: delivery fails, the merchant waits.
    relays.CONGO.mode = 'webhooks-down';
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => (await deliveries(invoice, 'RESTODEMO')).CONGO === 'failed');
    expect(await deliveries(invoice, 'RESTODEMO')).toEqual({ CONGO: 'failed', RESTODEMO: 'blocked' });
    expect((await bench('RESTODEMO', 'state', { invoice }))).toMatchObject({ request_state: 'Generated', entries: [] });
    relays.CONGO.mode = 'up';
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id IN
      (SELECT id FROM konektag.link_pay_network_transactions WHERE invoice=$1 AND beneficiary_site='RESTODEMO')`, [invoice]);
    await siteWebhookService.processDue();
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    expect((await bench('RESTODEMO', 'state', { invoice }))).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
    expect((await bench('CONGO', 'state', {})).balances.find((b: any) => b.beneficiary === 'RESTODEMO')).toMatchObject({ remaining: 975 });
  }, 120000);
});

// Network follow-up (Konektag Network Operation on Congo), driven by the real outbox worker pass.
const operations = async (site: Site = 'CONGO') => (await bench(site, 'operations', {})) as any[];
const operation = async (key: string, site: Site = 'CONGO') => (await operations(site)).filter(o => o.name === key);
const worker = async () => (await import('../../src/application/outbox-dispatcher.ts')).processPending();
const networkEvents = async (ref: string) => Number((await pool.query(
  `SELECT count(*) n FROM konektag.outbox_events WHERE event_type='NetworkOperationChanged' AND aggregate_ref LIKE $1`, [ref + '%'])).rows[0].n);

describe('Network follow-up from issuance, real API, outbox and Congo site', () => {
  it('distinct sites: the issued link is pending on Congo, the payment updates the same row, then the merchant is settled', async () => {
    const before = (await bench('CONGO', 'state', {})).balances.find((b: any) => b.beneficiary === 'RESTODEMO');
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 1500 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    await worker();
    const key = `link-pay:${issued.slug}`;
    expect(await operation(key)).toMatchObject([{ operation_type: 'Link Pay', status: 'En attente de paiement', reference: issued.slug,
      amount: 1500, currency: 'XAF', transaction: null }]);
    // Pending: nothing owed to the merchant yet.
    expect((await bench('CONGO', 'state', {})).balances.find((b: any) => b.beneficiary === 'RESTODEMO')).toEqual(before);
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    const [paid] = await operation(key);
    expect(paid).toMatchObject({ status: 'Payé', amount: 1500 });
    expect(paid.transaction).toBeTruthy();
    expect((await bench('RESTODEMO', 'state', { invoice }))).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
    // Replayed issuance event (outbox retry): no second row, no write, never back to pending.
    await pool.query(`UPDATE konektag.outbox_events SET processed_at=NULL WHERE aggregate_ref=$1`, [`${key}:issued`]);
    await worker();
    expect(await operation(key)).toEqual([paid]);
    expect(await networkEvents(key)).toBe(1);
  }, 180000);

  it('Congo merchant issues a Link Pay for a payer of the France Network: pending on Congo, paid on the same row', async () => {
    // Normal Frappe path: the merchant user clicks « Générer » on its invoice; Link Pay never asks for the payer.
    const forFrance = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 1700 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice: forFrance, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    expect(issued).toMatchObject({ state: 'Generated' });
    await worker();
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ operation_type: 'Link Pay', status: 'En attente de paiement' }]);
    // The operation lives on the link's Network (Congo), not on the payer's (resto.test plays France here).
    expect(await operation(`link-pay:${issued.slug}`, 'RESTODEMO')).toEqual([]);
    // A France resident pays the first link: the same Congo row becomes Payé, the merchant is settled.
    const french = await payer('FR');  // resident of the France Network
    const { rows: [routing] } = await pool.query(`SELECT payment_country FROM konektag.payment_country_mappings
      WHERE detected_country='FR' AND status='ACTIVE'`);
    expect(routing.payment_country).toBe('FR');
    const response: Response = await pay({ locals: { user: french },
      request: new Request('http://x/api/pay/pay-link', { method: 'POST', body: JSON.stringify({ slug: issued.slug }) }) } as any);
    expect(response.status).toBe(201);
    await waitFor(async () => JSON.stringify(await deliveries(forFrance, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'Payé' }]);
    expect(await operation(`link-pay:${issued.slug}`, 'RESTODEMO')).toEqual([]);
  }, 180000);

  it('same site (360°): one delivery updates the operation and settles the Congo invoice', async () => {
    const invoice = (await bench('CONGO', 'new_invoice', { like: prepared.CONGO.invoice, amount: 2500 })).invoice;
    const issued = (await bench('CONGO', 'generate', { invoice, user: prepared.CONGO.user, api_url: apiUrl }));
    await worker();
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'En attente de paiement' }]);
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'CONGO')) === JSON.stringify({ CONGO: 'delivered' }));
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'Payé' }]);
    expect((await bench('CONGO', 'state', { invoice }))).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
  }, 180000);

  it('payment received before the issuance notification: the row is created paid and the late issuance never reverts it', async () => {
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 1200 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => (await deliveries(invoice, 'RESTODEMO')).CONGO === 'delivered');
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'Payé' }]);
    await worker();  // the issuance event arrives now
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'Payé', amount: 1200 }]);
  }, 180000);

  async function rechargeOrder(amount: number) {
    const buyer = await payer();
    // The routed site is frozen on the order at purchase (konektag-cg for a CG resident).
    const { apiPaymentCheckoutService } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
    const { order } = await apiPaymentCheckoutService.createWalletRechargeOrder({ targetUserId: buyer.id, amount, currency: 'XAF',
      paymentCountry: 'CG', konektagSite: { slug: 'konektag-cg' } });
    return order;
  }
  const attemptId = async (reference: string) => (await pool.query(
    `SELECT id FROM konektag.payment_provider_attempts WHERE provider_reference=$1`, [reference])).rows[0].id as string;

  it('PawaPay recharge: pending once accepted, the verified webhook updates the same row, a replay writes nothing', async () => {
    const { paymentProviderAttemptService } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts');
    const order = await rechargeOrder(5000);
    const depositId = await paymentProviderAttemptService.createOrGetPawaPayApiCheckoutAttempt({ orderId: order.id, amount: 5000,
      currency: 'XAF', providerConfigurationKey: null });
    await paymentProviderAttemptService.recordRechargeAccepted('pawapay', depositId);
    await worker();
    const key = `recharge:${await attemptId(depositId)}`;
    expect(await operation(key)).toMatchObject([{ operation_type: 'Recharge Points K', status: 'En attente de paiement',
      provider: 'pawapay', provider_reference: depositId, amount: 5000 }]);
    const deposit = { depositId, status: 'COMPLETED', amount: '5000', currency: 'XAF' };
    expect(await paymentProviderAttemptService.consumePawaPayDeposit(deposit as any, sha('webhook-1')))
      .toMatchObject({ outcome: 'ready_to_settle' });
    await worker();
    const [paid] = await operation(key);
    expect(paid).toMatchObject({ status: 'Payé', provider_reference: depositId });
    // Webhook replayed (settlement still to retry, or already done): no new event, no Frappe write.
    expect(['ready_to_settle', 'deduplicated']).toContain((await paymentProviderAttemptService.consumePawaPayDeposit(deposit as any, sha('webhook-1'))).outcome);
    await worker();
    expect(await operation(key)).toEqual([paid]);
    expect(await networkEvents(key)).toBe(2);
  }, 180000);

  it('PawaPay recharge without webhook: the existing reconciliation produces the same update (failed)', async () => {
    const { paymentProviderAttemptService } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts');
    const order = await rechargeOrder(3000);
    const depositId = await paymentProviderAttemptService.createOrGetPawaPayApiCheckoutAttempt({ orderId: order.id, amount: 3000,
      currency: 'XAF', providerConfigurationKey: null });
    await paymentProviderAttemptService.recordRechargeAccepted('pawapay', depositId);
    await worker();
    const key = `recharge:${await attemptId(depositId)}`;
    expect(await operation(key)).toMatchObject([{ status: 'En attente de paiement' }]);
    pawaPayDeposits[depositId] = { depositId, status: 'FAILED', amount: '3000', currency: 'XAF', failureReason: 'INSUFFICIENT_BALANCE' };
    await worker();  // reconciliation polls PawaPay, then the outbox delivers
    await worker();
    expect(await operation(key)).toMatchObject([{ status: 'Échoué', failure_reason: 'INSUFFICIENT_BALANCE' }]);
  }, 180000);

  it('Network operator of Congo: reads every Congo operation, pending included; the other site has none', async () => {
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 900 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    await worker();
    const read = async (site: Site, keys: { api_key: string; api_secret: string }) => {
      const url = `http://localhost:${relays[site].port}/api/resource/Konektag%20Network%20Operation?fields=${encodeURIComponent('["name","status"]')}&limit_page_length=500`;
      const response = await fetch(url, { headers: { Authorization: `token ${keys.api_key}:${keys.api_secret}`, Accept: 'application/json' } });
      return { status: response.status, rows: response.ok ? (await response.json()).data as any[] : [] };
    };
    // A Network team member (Link Pay Manager, desk user, no API role) on the Congo site.
    const congoOperator = await bench('CONGO', 'operator', { email: 'reseau-congo@example.test', roles: ['Link Pay Manager'] });
    const congo = await read('CONGO', congoOperator);
    expect(congo.status).toBe(200);
    expect(congo.rows).toEqual(expect.arrayContaining([{ name: `link-pay:${issued.slug}`, status: 'En attente de paiement' }]));
    expect(congo.rows.some(r => r.status === 'Payé')).toBe(true);
    expect(congo.rows.length).toBe((await operations()).length);
    // The same rights on another Frappe site show none of Congo's operations (one database per site).
    const restoOperator = await bench('RESTODEMO', 'operator', { email: 'reseau-congo@example.test', roles: ['Link Pay Manager'] });
    expect(await read('RESTODEMO', restoOperator)).toEqual({ status: 200, rows: [] });
    // A user without a Network role reads nothing, and an operator cannot write.
    const other = await bench('CONGO', 'operator', { email: 'vendeur-congo@example.test', roles: ['Sales User'] });
    expect((await read('CONGO', other)).status).toBe(403);
    const write = await fetch(`http://localhost:${relays.CONGO.port}/api/method/konektag_360.network_operations.record`, {
      method: 'POST', headers: { Authorization: `token ${congoOperator.api_key}:${congoOperator.api_secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: { key: `link-pay:${issued.slug}`, type: 'link_pay', status: 'paid', eventKey: 'forged', reference: issued.slug } }) });
    expect(write.status).toBe(403);
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'En attente de paiement' }]);
  }, 180000);

  it('Stripe recharge (France resident, EUR): displayed fee = checkout fee, paid on the same row, a replayed webhook credits once', async () => {
    expect(await bench('RESTODEMO', 'stripe_payment_context', {})).toMatchObject({ 'LINK-FR-STRIPE': 'Approved', 'STRIPE-FR': 'Approved' });
    env.KTG_FR_STRIPE_TEST_PUBLISHABLE_KEY = 'pk_test_e2e_only';
    env.KTG_FR_STRIPE_TEST_WEBHOOK_SECRET = 'whsec_e2e_only_0123456789';
    // France resident, recorded at registration.
    const buyer = crypto.randomUUID();
    await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state, legal_country)
      VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED', 'FR')`, [buyer, crypto.randomUUID(), 'fr' + buyer.slice(0, 8), sha(buyer)]);
    const payerIdentity = { userId: buyer, keycloakId: null, username: 'fr' + buyer.slice(0, 8), email: buyer + '@example.test' } as any;
    // Purchase: routed server-side to konektag-cg, context and fees read on Congo.
    const { POST: buy } = await import('../../src/api/routes/pay/recharges.ts');
    const purchase = await buy({ request: new Request('http://x/api/pay/recharges', { method: 'POST',
      body: JSON.stringify({ amount: 2500, currency: 'EUR' }) }), locals: { user: { id: buyer } } } as any);
    const body = await purchase.json();
    expect(purchase.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ konektagSite: 'konektag-fr', paymentContext: { country: 'FR', currency: 'EUR' } });
    const card = body.paymentContext.providers.find((p: any) => p.paymentMethod === 'card');
    expect(card.fees).toEqual({ percentageBps: 400, fixedAmount: 0 });
    const token = new URL(body.checkoutUrl).searchParams.get('token')!;
    const { apiPaymentCheckoutService } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
    const { paymentProviderAttemptService } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts');
    // Funding with the signed selection: the fee applied is the displayed rate on the taxed amount (existing rules).
    const funding = await apiPaymentCheckoutService.prepareSelectedFunding(token, payerIdentity, card.selectionToken);
    const order = (await pool.query(`SELECT * FROM konektag.api_payment_orders WHERE id=$1`, [body.id])).rows[0];
    const taxed = Number(order.subtotal_amount) + Number(order.tax_amount);
    const expectedFee = Math.round(taxed * card.fees.percentageBps / 10_000) + card.fees.fixedAmount;
    expect([Number(order.fee_amount), Number(order.external_amount)]).toEqual([expectedFee, taxed + expectedFee]);
    expect(Number(order.fee_amount)).toBeGreaterThan(0);
    expect(funding).toBeTruthy();
    // The create-intent route, without the call to Stripe: PaymentIntent stored, attempt recorded, pending.
    const stripeOrder = await apiPaymentCheckoutService.getStripeOrder(token, payerIdentity);
    const intent = { id: `pi_e2e_ok_${crypto.randomUUID().slice(0, 8)}`, object: 'payment_intent', amount: stripeOrder.providerExpectedAmount,
      currency: 'eur', status: 'requires_payment_method',
      metadata: { konektag_source_type: 'api_payment', konektag_source_id: body.id, konektag_operation_id: body.id } };
    await apiPaymentCheckoutService.attachStripePaymentIntent(token, intent.id);
    await paymentProviderAttemptService.createOrUpdateStripeApiCheckoutAttempt({ orderId: body.id, paymentIntent: intent as any,
      metadata: { providerConfigurationKey: 'KTG_FR_STRIPE_TEST' } });
    await paymentProviderAttemptService.recordRechargeAccepted('stripe', intent.id);
    await worker();
    const key = `recharge:${await attemptId(intent.id)}`;
    expect(await operation(key, 'RESTODEMO')).toMatchObject([{ status: 'En attente de paiement', provider_reference: intent.id, amount: Number(order.external_amount) }]);  // order in currency units, attempt in cents
    // Verified Stripe webhook (real route and signature check), then the same event delivered again.
    const Stripe = (await import('stripe')).default;
    const { POST: webhook } = await import('../../src/api/routes/webhooks/stripe/[configurationKey].ts');
    const payload = JSON.stringify({ id: `evt_${intent.id}`, object: 'event', type: 'payment_intent.succeeded', api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000), data: { object: { ...intent, status: 'succeeded' } } });
    const deliver = () => webhook({ params: { configurationKey: 'KTG_FR_STRIPE_TEST' }, request: new Request('http://x/webhook', {
      method: 'POST', body: payload, headers: { 'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({ payload,
        secret: env.KTG_FR_STRIPE_TEST_WEBHOOK_SECRET! }) } }) } as any);
    const credits = async () => (await pool.query(`SELECT count(*)::int n, coalesce(sum(quantity),0)::int k FROM konektag.points_acquisitions
      WHERE order_id=$1 AND status='completed'`, [body.id])).rows[0];
    const first = await deliver();
    expect(first.status, await first.clone().text()).toBe(200);
    const credited = await credits();
    expect(credited.n).toBe(1);
    await worker();
    const [paid] = await operation(key, 'RESTODEMO');
    expect(paid).toMatchObject({ status: 'Payé', provider: 'stripe', provider_reference: intent.id });
    expect((await deliver()).status).toBe(200);
    await worker();
    expect(await credits()).toEqual(credited);
    expect(await operation(key, 'RESTODEMO')).toEqual([paid]);
    expect(await networkEvents(key)).toBe(2);
  }, 180000);

  it('Stripe recharge: pending once the PaymentIntent exists, then failed from the verified event', async () => {
    const { paymentProviderAttemptService } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts');
    const order = await rechargeOrder(4000);
    const intent = { id: `pi_e2e_${crypto.randomUUID().slice(0, 8)}`, amount: 4000, currency: 'xaf', status: 'requires_payment_method',
      metadata: { konektag_source_type: 'api_payment', konektag_source_id: order.id, konektag_operation_id: order.id } };
    await paymentProviderAttemptService.createOrUpdateStripeApiCheckoutAttempt({ orderId: order.id, paymentIntent: intent as any });
    await paymentProviderAttemptService.recordRechargeAccepted('stripe', intent.id);
    await worker();
    const key = `recharge:${await attemptId(intent.id)}`;
    expect(await operation(key)).toMatchObject([{ status: 'En attente de paiement', provider: 'stripe', provider_reference: intent.id }]);
    expect(await paymentProviderAttemptService.consumeStripeEvent({ id: `evt_${intent.id}`, type: 'payment_intent.payment_failed',
      payloadHash: sha(intent.id), paymentIntent: intent as any })).toMatchObject({ outcome: 'failed' });
    await worker();
    expect(await operation(key)).toMatchObject([{ status: 'Échoué', failure_reason: 'PAYMENT_FAILED' }]);
  }, 180000);
});

// « Régulariser » from the Frappe back-office of each Network site: real Frappe rights and screen methods,
// real API route, real outbox worker. Congo = PawaPay XAF, resto.test playing Europe = Stripe EUR.
describe('Régulariser depuis Frappe (back-office Réseau)', () => {
  const users = { regCongo: 'regul-congo@example.test', regEurope: 'regul-europe@example.test',
    readerCongo: 'lecture-congo@example.test', nobodyCongo: 'vendeur2-congo@example.test' };
  const reg = async (site: Site, user: string, name: string, extra: Record<string, unknown> = {}) => {
    const out = await bench(site, 'regularize_as', { user, name, api_url: regularizationUrl, ...extra });
    if (out?.error) console.error('[regularize_as]', user, extra.option, out.error, String(out.traceback || '').slice(-900));
    return out;
  };
  const credits = async (orderId: string) => Number((await pool.query(
    `SELECT count(*) n FROM konektag.points_acquisitions WHERE order_id=$1 AND status='completed'`, [orderId])).rows[0].n);
  let services: any;
  const attemptId = async (reference: string) => (await pool.query(
    `SELECT id FROM konektag.payment_provider_attempts WHERE provider_reference=$1`, [reference])).rows[0].id as string;

  beforeAll(async () => {
    await bench('CONGO', 'operator', { email: users.regCongo, roles: ['Konektag Network Regularizer', 'Link Pay Manager'] });
    await bench('RESTODEMO', 'operator', { email: users.regEurope, roles: ['Konektag Network Regularizer'] });
    await bench('CONGO', 'operator', { email: users.readerCongo, roles: ['Link Pay Manager'] });
    await bench('CONGO', 'operator', { email: users.nobodyCongo, roles: ['Sales User'] });
    expect(await bench('CONGO', 'congo_payment_context', {})).toMatchObject({ 'LINK-CG-PAWAPAY': 'Approved' });
    expect(await bench('RESTODEMO', 'stripe_payment_context', {})).toMatchObject({ 'LINK-FR-STRIPE': 'Approved' });
    env.KTG_CG_PAWAPAY_SANDBOX_API_URL = env.PAWAPAY_API_URL;
    env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'e2e-only';
    services = {
      checkout: (await import('../../src/application/services/pay/api-payment-checkout-service.ts')).apiPaymentCheckoutService,
      attempts: (await import('../../src/application/services/pay/payment-provider-attempt-service.ts')).paymentProviderAttemptService,
      pawapay: (await import('../../src/application/services/pay/pawapay-deposit-service.ts')).pawaPayDepositService,
      buy: (await import('../../src/api/routes/pay/recharges.ts')).POST,
      expire: (await import('../../src/application/network-operations/regularization.ts')).enqueueLinkExpired,
    };
  }, 120000);

  /** Routed Points K purchase of a resident (registration country), funded with the provider of its site. */
  async function purchase(country: 'CG' | 'FR', amount: number, currency: string, method: 'mobile_money' | 'card') {
    const buyer = crypto.randomUUID();
    await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state, legal_country)
      VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED', $5)`, [buyer, crypto.randomUUID(), 'b' + buyer.slice(0, 8), sha(buyer), country]);
    const payer = { userId: buyer, keycloakId: null, username: 'b' + buyer.slice(0, 8), email: buyer + '@example.test' } as any;
    const response = await services.buy({ request: new Request('http://x/api/pay/recharges', { method: 'POST',
      body: JSON.stringify({ amount, currency }) }), locals: { user: { id: buyer } } } as any);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    const provider = body.paymentContext.providers.find((p: any) => p.paymentMethod === method);
    const token = new URL(body.checkoutUrl).searchParams.get('token')!;
    await services.checkout.prepareSelectedFunding(token, payer, provider.selectionToken);
    return { body, token, payer, orderId: body.id as string };
  }

  async function pawapayRecharge(amount = 5000) {
    const p = await purchase('CG', amount, 'XAF', 'mobile_money');
    const order = await services.checkout.getMobileMoneyOrder(p.token, p.payer);
    const depositId = await services.attempts.createOrGetPawaPayApiCheckoutAttempt({ orderId: order.id, amount: order.externalAmount,
      currency: order.currency, providerConfigurationKey: order.providerConfigurationKey });
    await services.checkout.confirmCheckout(p.token, 'mobile_money', p.payer);
    await services.attempts.recordRechargeAccepted('pawapay', depositId);
    await worker();
    const key = `recharge:${await attemptId(depositId)}`;
    const deposit = (status: string) => ({ depositId, status, amount: String(order.externalAmount), currency: 'XAF' });
    // The verified webhook path (also used by the reconciliation).
    const webhook = (status = 'COMPLETED') => services.pawapay.consume(deposit(status), JSON.stringify(deposit(status)));
    return { ...p, depositId, key, amount: order.externalAmount, deposit, webhook };
  }

  async function stripeRecharge(amount = 2500) {
    const p = await purchase('FR', amount, 'EUR', 'card');
    const stripeOrder = await services.checkout.getStripeOrder(p.token, p.payer);
    const intent = { id: `pi_e2e_reg_${crypto.randomUUID().slice(0, 8)}`, object: 'payment_intent', amount: stripeOrder.providerExpectedAmount,
      currency: 'eur', status: 'requires_payment_method',
      metadata: { konektag_source_type: 'api_payment', konektag_source_id: p.orderId, konektag_operation_id: p.orderId } };
    await services.checkout.attachStripePaymentIntent(p.token, intent.id);
    await services.attempts.createOrUpdateStripeApiCheckoutAttempt({ orderId: p.orderId, paymentIntent: intent as any,
      metadata: { providerConfigurationKey: 'KTG_FR_STRIPE_TEST' } });
    await services.attempts.recordRechargeAccepted('stripe', intent.id);
    await worker();
    return { ...p, intent, key: `recharge:${await attemptId(intent.id)}` };
  }

  const evidence = (r: { depositId: string; amount: number }, extra: Record<string, unknown> = {}) => ({
    reason: 'Relevé PawaPay du jour : dépôt confirmé', evidence: `Relevé PawaPay ${r.depositId} ${r.amount} XAF`,
    reference: r.depositId, amount: String(r.amount), currency: 'XAF', ...extra });

  it('two Network sites, two providers: right site, provider, account and reference; options by rights', async () => {
    const cg = await pawapayRecharge(5000);
    const fr = await stripeRecharge(2500);
    expect(await operation(cg.key, 'CONGO')).toMatchObject([{ status: 'En attente de paiement', provider: 'pawapay', provider_reference: cg.depositId }]);
    expect(await operation(fr.key, 'RESTODEMO')).toMatchObject([{ status: 'En attente de paiement', provider: 'stripe', provider_reference: fr.intent.id }]);
    expect(await operation(cg.key, 'RESTODEMO')).toEqual([]);
    expect(await operation(fr.key, 'CONGO')).toEqual([]);
    const congo = (await reg('CONGO', users.regCongo, cg.key)).options;
    expect(congo.operation).toMatchObject({ provider: 'pawapay', providerAccount: 'KTG_CG_PAWAPAY_SANDBOX', providerReference: cg.depositId,
      amount: cg.amount, currency: 'XAF', apiState: 'pending' });
    expect(congo.options.map((o: any) => [o.option, o.available])).toEqual([['verify', true], ['confirm_paid', true], ['confirm_failed', true]]);
    const europe = (await reg('RESTODEMO', users.regEurope, fr.key)).options;
    expect(europe.operation).toMatchObject({ provider: 'stripe', providerAccount: 'KTG_FR_STRIPE_TEST', providerReference: fr.intent.id, currency: 'EUR' });
    const reader = (await reg('CONGO', users.readerCongo, cg.key)).options;
    expect(reader.options.map((o: any) => [o.option, o.available, o.reason])).toEqual([
      ['verify', true, null], ['confirm_paid', false, 'ROLE_REQUIRED'], ['confirm_failed', false, 'ROLE_REQUIRED']]);
  }, 240000);

  it('on-demand verification: in progress, source unavailable, paid, failed; traced in Frappe', async () => {
    const a = await pawapayRecharge(6000);
    pawaPayDeposits[a.depositId] = a.deposit('ACCEPTED');
    expect((await reg('CONGO', users.readerCongo, a.key, { option: 'verify' })).result).toMatchObject({ result: 'in_progress' });
    pawaPayDeposits[a.depositId] = 'ERROR';
    expect((await reg('CONGO', users.readerCongo, a.key, { option: 'verify' })).result).toMatchObject({ result: 'unavailable' });
    await worker();
    expect(await operation(a.key)).toMatchObject([{ status: 'En attente de paiement' }]);
    pawaPayDeposits[a.depositId] = a.deposit('COMPLETED');
    expect((await reg('CONGO', users.readerCongo, a.key, { option: 'verify' })).result).toMatchObject({ result: 'applied', label: 'Appliqué' });
    expect(await credits(a.orderId)).toBe(1);
    expect((await reg('CONGO', users.readerCongo, a.key, { option: 'verify' })).result).toMatchObject({ result: 'already_processed', label: 'Déjà traité' });
    await worker();
    expect(await operation(a.key)).toMatchObject([{ status: 'Payé' }]);
    expect((await bench('CONGO', 'journal', { name: a.key })).map((j: any) => [j.option, j.result, j.user, j.site])).toEqual([
      ['Vérifier le statut du paiement', 'Paiement en cours', users.readerCongo, 'CONGO'],
      ['Vérifier le statut du paiement', 'Vérification indisponible', users.readerCongo, 'CONGO'],
      ['Vérifier le statut du paiement', 'Appliqué', users.readerCongo, 'CONGO'],
      ['Vérifier le statut du paiement', 'Déjà traité', users.readerCongo, 'CONGO']]);
    const b = await pawapayRecharge(4000);
    pawaPayDeposits[b.depositId] = b.deposit('FAILED');
    expect((await reg('CONGO', users.regCongo, b.key, { option: 'verify' })).result).toMatchObject({ result: 'applied' });
    await worker();
    expect(await operation(b.key)).toMatchObject([{ status: 'Échoué' }]);
    // Stripe, on demand, with the account that processed the PaymentIntent.
    const s = await stripeRecharge(1500);
    stripeIntents[s.intent.id] = { ...s.intent, status: 'processing' };
    expect((await reg('RESTODEMO', users.regEurope, s.key, { option: 'verify' })).result).toMatchObject({ result: 'in_progress' });
    stripeIntents[s.intent.id] = { ...s.intent, status: 'succeeded' };
    expect((await reg('RESTODEMO', users.regEurope, s.key, { option: 'verify' })).result).toMatchObject({ result: 'applied' });
    expect(await credits(s.orderId)).toBe(1);
    await worker();
    expect(await operation(s.key, 'RESTODEMO')).toMatchObject([{ status: 'Payé', provider: 'stripe' }]);
  }, 300000);

  it('manual paid confirmation with the webhook before, during and after: one operation, one credit, one finalisation', async () => {
    const before = await pawapayRecharge(3000);
    await before.webhook();
    expect(await credits(before.orderId)).toBe(1);
    expect((await reg('CONGO', users.regCongo, before.key, { option: 'confirm_paid', ...evidence(before) })).result)
      .toMatchObject({ result: 'already_processed', label: 'Déjà traité' });
    const during = await pawapayRecharge(3100);
    await Promise.all([reg('CONGO', users.regCongo, during.key, { option: 'confirm_paid', ...evidence(during) }), during.webhook()]);
    const after = await pawapayRecharge(3200);
    expect((await reg('CONGO', users.regCongo, after.key, { option: 'confirm_paid', ...evidence(after) })).result).toMatchObject({ result: 'applied' });
    await after.webhook();
    await worker();
    for (const r of [before, during, after]) {
      expect(await credits(r.orderId)).toBe(1);
      expect(await operation(r.key)).toMatchObject([{ status: 'Payé' }]);
      expect(await networkEvents(`${r.key}:paid`)).toBe(1);
    }
    expect((await bench('CONGO', 'journal', { name: after.key }))[0]).toMatchObject({ option: 'Enregistrer un paiement confirmé',
      result: 'Appliqué', user: users.regCongo, reason: 'Relevé PawaPay du jour : dépôt confirmé', evidence_reference: after.depositId });
    // Evidence that does not match the operation is refused; a confirmed failure is applied.
    const failed = await pawapayRecharge(2800);
    expect((await reg('CONGO', users.regCongo, failed.key, { option: 'confirm_failed', ...evidence(failed, { amount: '1' }) })).result)
      .toMatchObject({ result: 'refused' });
    expect((await reg('CONGO', users.regCongo, failed.key, { option: 'confirm_failed', ...evidence(failed,
      { reason: 'Dépôt rejeté selon le relevé PawaPay' }) })).result).toMatchObject({ result: 'applied' });
    await worker();
    expect(await operation(failed.key)).toMatchObject([{ status: 'Échoué' }]);
    expect(await credits(failed.orderId)).toBe(0);
  }, 300000);

  it('Link Pay: regularisation after a lost network delivery (distinct and shared sites), expiry, late in-time confirmation', async () => {
    const txOf = async (slug: string) => (await pool.query(`SELECT t.id, t.gross_minor FROM konektag.link_pay_network_transactions t
      JOIN konektag.checkout_intents ci ON ci.id = t.checkout_intent_id WHERE ci.public_id=$1`, [slug])).rows[0];
    // Distinct sites: network delivery lost, then « Vérifier » from Congo re-delivers; the merchant follows.
    const invoice = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 1100 })).invoice;
    const issued = (await bench('RESTODEMO', 'generate', { invoice, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    await worker();
    relays.CONGO.mode = 'webhooks-down';
    expect((await payLink(issued.slug)).status).toBe(201);
    await waitFor(async () => (await deliveries(invoice, 'RESTODEMO')).CONGO === 'failed');
    relays.CONGO.mode = 'up';
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'En attente de paiement' }]);
    expect((await reg('CONGO', users.readerCongo, `link-pay:${issued.slug}`, { option: 'verify' })).result).toMatchObject({ result: 'applied' });
    await waitFor(async () => JSON.stringify(await deliveries(invoice, 'RESTODEMO')) === JSON.stringify({ CONGO: 'delivered', RESTODEMO: 'delivered' }));
    expect(await operation(`link-pay:${issued.slug}`)).toMatchObject([{ status: 'Payé' }]);
    expect((await bench('RESTODEMO', 'state', { invoice }))).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
    // Shared site: « Enregistrer un paiement confirmé » with the Network transaction as evidence.
    const own = (await bench('CONGO', 'new_invoice', { like: prepared.CONGO.invoice, amount: 1300 })).invoice;
    const ownLink = (await bench('CONGO', 'generate', { invoice: own, user: prepared.CONGO.user, api_url: apiUrl }));
    await worker();
    relays.CONGO.mode = 'webhooks-down';
    expect((await payLink(ownLink.slug)).status).toBe(201);
    await waitFor(async () => (await deliveries(own, 'CONGO')).CONGO === 'failed');
    relays.CONGO.mode = 'up';
    const tx = await txOf(ownLink.slug);
    expect((await reg('CONGO', users.regCongo, `link-pay:${ownLink.slug}`, { option: 'confirm_paid', reason: 'Transaction Réseau confirmée par l’API',
      evidence: `Transaction ${tx.id}`, reference: tx.id, amount: String(Number(tx.gross_minor)), currency: 'XAF' })).result).toMatchObject({ result: 'applied' });
    expect(await deliveries(own, 'CONGO')).toEqual({ CONGO: 'delivered' });
    expect(await operation(`link-pay:${ownLink.slug}`)).toMatchObject([{ status: 'Payé' }]);
    expect((await bench('CONGO', 'state', { invoice: own }))).toMatchObject({ request_state: 'Paid', invoice_status: 'Paid' });
    // Expiry: an unpaid link becomes Expiré at its deadline, which is shown.
    const late = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 700 })).invoice;
    const unpaid = (await bench('RESTODEMO', 'generate', { invoice: late, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    await worker();
    await pool.query(`UPDATE konektag.checkout_intents SET expiration = now() - interval '1 minute' WHERE public_id=$1`, [unpaid.slug]);
    await worker();
    const [expired] = await operation(`link-pay:${unpaid.slug}`);
    expect(expired.status).toBe('Expiré');
    expect(expired.expires_at).toBeTruthy();
    expect((await reg('CONGO', users.regCongo, `link-pay:${unpaid.slug}`)).options.options.map((o: any) => [o.option, o.reason])).toEqual([
      ['verify', null], ['confirm_paid', 'NO_PAYMENT_RECORDED'], ['confirm_failed', 'LINK_EXPIRES_AT_DEADLINE']]);
    // A payment made in time whose confirmation reaches Frappe after the Expiré notification: Payé, with its payment date.
    const inTime = (await bench('RESTODEMO', 'new_invoice', { like: prepared.RESTODEMO.invoice, amount: 800 })).invoice;
    const paidLink = (await bench('RESTODEMO', 'generate', { invoice: inTime, user: prepared.RESTODEMO.user, api_url: apiUrl }));
    await worker();
    relays.CONGO.mode = 'webhooks-down';
    expect((await payLink(paidLink.slug)).status).toBe(201);
    await waitFor(async () => (await deliveries(inTime, 'RESTODEMO')).CONGO === 'failed');
    const { rows: [intent] } = await pool.query(`SELECT id FROM konektag.checkout_intents WHERE public_id=$1`, [paidLink.slug]);
    await services.expire(pool, { slug: paidLink.slug, owner: 'CONGO', checkoutIntentId: intent.id, expiresAt: new Date().toISOString() });
    relays.CONGO.mode = 'up';
    await worker();
    expect(await operation(`link-pay:${paidLink.slug}`)).toMatchObject([{ status: 'Expiré' }]);
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id IN
      (SELECT id FROM konektag.link_pay_network_transactions WHERE invoice=$1 AND beneficiary_site='RESTODEMO')`, [inTime]);
    await siteWebhookService.processDue();
    await waitFor(async () => (await deliveries(inTime, 'RESTODEMO')).CONGO === 'delivered');
    const [final] = await operation(`link-pay:${paidLink.slug}`);
    const { rows: [paidTx] } = await pool.query(`SELECT paid_at FROM konektag.link_pay_network_transactions WHERE invoice=$1 AND beneficiary_site='RESTODEMO'`, [inTime]);
    expect(final.status).toBe('Payé');
    expect(new Date(final.settled_at + 'Z').getTime()).toBeLessThanOrEqual(new Date(paidTx.paid_at).getTime() + 1000);
  }, 400000);

  it('access and recovery: refusals off role and off site, conflict with a final result, retry after a technical failure', async () => {
    const r = await pawapayRecharge(2600);
    expect(await reg('CONGO', users.readerCongo, r.key, { option: 'confirm_paid', ...evidence(r) })).toMatchObject({ error: expect.stringContaining('Konektag Network Regularizer') });
    expect(await reg('CONGO', users.nobodyCongo, r.key)).toHaveProperty('error');
    // Direct API call from another site's channel: refused, whatever the operator claims.
    const direct = await fetch(regularizationUrl.replace(env.E2E_GATEWAY!, '127.0.0.1'), { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Konektag-Frappe-Site': 'RESTODEMO', 'X-Konektag-Frappe-Token': env.E2E_RESTODEMO_TOKEN! },
      body: JSON.stringify({ key: r.key, option: 'confirm_paid', operator: { user: 'x', roles: ['Konektag Network Regularizer'] } }) });
    expect([direct.status, (await direct.json()).error]).toEqual([403, 'OPERATION_OF_ANOTHER_SITE']);
    await r.webhook();
    await worker();
    expect((await reg('CONGO', users.regCongo, r.key, { option: 'confirm_failed', ...evidence(r, { reason: 'Échec signalé par le client' }) })).result)
      .toMatchObject({ result: 'conflict' });
    await worker();
    expect(await operation(r.key)).toMatchObject([{ status: 'Payé' }]);
    // Technical failure: the screen reports it and the retry applies once.
    const t = await pawapayRecharge(2700);
    apiDown = true;
    expect((await reg('CONGO', users.regCongo, t.key, { option: 'confirm_paid', ...evidence(t) })).result)
      .toMatchObject({ result: 'temporary_failure', label: 'Échec temporaire', retry: true });
    apiDown = false;
    expect((await reg('CONGO', users.regCongo, t.key, { option: 'confirm_paid', ...evidence(t) })).result).toMatchObject({ result: 'applied' });
    expect((await reg('CONGO', users.regCongo, t.key, { option: 'confirm_paid', ...evidence(t) })).result).toMatchObject({ result: 'already_processed' });
    expect(await credits(t.orderId)).toBe(1);
    expect((await bench('CONGO', 'journal', { name: t.key })).map((j: any) => j.result)).toEqual(['Échec temporaire', 'Appliqué', 'Déjà traité']);
  }, 300000);
});
