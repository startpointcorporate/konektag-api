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

async function payer() {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state)
    VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED')`, [id, crypto.randomUUID(), 'p' + id.slice(0, 8), sha(id)]);
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
  pool = (await import('../../src/infrastructure/database/pool.ts')).default;
  // Link Pay must work without konektag.merchant_profiles: remove it from this throwaway database.
  await pool.query('DROP TABLE IF EXISTS konektag.merchant_profiles CASCADE');
  expect((await pool.query(`SELECT to_regclass('konektag.merchant_profiles') AS t`)).rows[0].t).toBeNull();
  routes = await import('../../src/api/routes/integrations/frappe/payment-links.ts');
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
    const response: Response = await routes[req.method as 'GET' | 'POST']({ request, url, locals: {} } as any);
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  });
  await new Promise<void>(r => apiServer.listen(0, '0.0.0.0', () => r()));
  apiUrl = `http://${env.E2E_GATEWAY}:${(apiServer.address() as AddressInfo).port}/api/integrations/frappe/payment-links`;
}, 60000);
afterAll(async () => { apiServer?.close(); Object.values(relays).forEach(r => r.server.close()); await pool?.end(); });

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
