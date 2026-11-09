// Link Pay through a network site, against a real PostgreSQL (all migrations up to 230) and two
// local HTTP Frappe doubles (CONGO = network, RESTODEMO = merchant). Never production.
// Run: DATABASE_URL=postgres://…/konektag_test NODE_ENV=development npx vitest run --config tests/integration/vitest.config.ts link-pay-network
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/konektag_test') throw new Error('DATABASE_URL must point at a throwaway database named konektag_test');
if (process.env.NODE_ENV !== 'development') throw new Error('NODE_ENV=development is required for http://localhost webhooks');

type Site = { invoices: Record<string, any>; terms: Record<string, any>; mode: 'up' | 'down' | 'no-ack'; received: any[] };
const sites: Record<string, Site> = {};
const servers: http.Server[] = [];
const tokens = { CONGO: 'c'.repeat(40), RESTODEMO: 'r'.repeat(40) };
const secrets = { CONGO: 'congo-webhook-secret-'.padEnd(40, 'x'), RESTODEMO: 'resto-webhook-secret-'.padEnd(40, 'y') };
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function frappeDouble(key: 'CONGO' | 'RESTODEMO') {
  const site: Site = sites[key] = { invoices: {}, terms: {}, mode: 'up', received: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const path = decodeURIComponent(req.url || '');
      if (req.method === 'GET' && path.startsWith('/api/resource/Sales Invoice/')) {
        const doc = site.invoices[path.slice('/api/resource/Sales Invoice/'.length)];
        return doc ? send(200, { data: doc }) : send(404, { exc_type: 'DoesNotExistError' });
      }
      if (path === '/api/method/konektag_360.link_pay.network.beneficiary_terms') {
        const terms = site.terms[JSON.parse(raw).beneficiary_site];
        return terms ? send(200, { message: terms }) : send(404, { exc_type: 'DoesNotExistError' });
      }
      if (path === '/api/method/konektag_360.link_pay.webhook.receive') {
        if (site.mode === 'down') return send(503, {});
        const signature = crypto.createHmac('sha256', secrets[key]).update(raw).digest('hex');
        if (req.headers['x-konektag-signature'] !== signature) return send(401, {});
        const payload = JSON.parse(raw);
        site.received.push(payload);
        if (site.mode === 'no-ack') return send(200, { message: {} });
        const ack: any = { transactionId: payload.transactionId };
        for (const role of payload.roles) ack[role] = role === 'network' ? 'recorded' : 'Paid';
        return send(200, { message: ack });
      }
      send(404, {});
    });
  });
  servers.push(server);
  return new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    process.env[`MARKETPLACE_FRAPPE_${key}_URL`] = `http://localhost:${(server.address() as AddressInfo).port}/`;
    process.env[`MARKETPLACE_FRAPPE_${key}_API_KEY`] = 'k'; process.env[`MARKETPLACE_FRAPPE_${key}_API_SECRET`] = 's';
    resolve();
  }));
}

process.env.LINK_PAY_FRAPPE_SITES = JSON.stringify({
  CONGO: { tokenSha256: sha(tokens.CONGO), webhookSecret: secrets.CONGO, network: true },
  RESTODEMO: { tokenSha256: sha(tokens.RESTODEMO), webhookSecret: secrets.RESTODEMO },
});

let pool: any, issue: any, list: any, pay: any, deliveries: any, siteWebhookService: any;
const approved = (site: string, extra: Record<string, unknown> = {}) => ({
  beneficiary_site: site, network_site: 'CONGO', beneficiary_name: site === 'CONGO' ? 'Konektag Congo' : 'Le Jardin du Fleuve',
  enabled: 1, approved: 1, approved_by: 'finance@konektag.cg', approved_on: '2026-11-10 09:00:00', terms_hash: 'a'.repeat(64),
  country: 'CG', fee_mode: site === 'CONGO' ? 'Exempt' : 'Percentage', fee_rate_bps: site === 'CONGO' ? 0 : 250,
  payout_ready: site !== 'CONGO', ...extra });
const invoice = (name: string, outstanding: number) => ({ name, company: 'C', docstatus: 1, is_return: 0, is_pos: 0,
  currency: 'XAF', party_account_currency: 'XAF', outstanding_amount: outstanding });

const ctx = (site: 'CONGO' | 'RESTODEMO', init: { method?: string; body?: unknown; attempt?: string; query?: string } = {}) => {
  const target = new URL('http://x/api/integrations/frappe/payment-links' + (init.query || ''));
  return { url: target, locals: {}, request: new Request(target, { method: init.method || 'GET',
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    headers: { 'X-Konektag-Frappe-Site': site, 'X-Konektag-Frappe-Token': tokens[site],
      ...(init.attempt ? { 'X-Idempotency-Key': init.attempt } : {}) } }) } as any;
};
const create = (site: 'CONGO' | 'RESTODEMO', name: string, attempt: string, network = 'CONGO') =>
  issue(ctx(site, { method: 'POST', attempt, body: { invoice: name, beneficiarySite: site, networkSite: network } }));
const payAs = (user: any, slug: string) => pay({ locals: { user }, request: new Request('http://x/api/pay/pay-link',
  { method: 'POST', body: JSON.stringify({ slug }) }) } as any);
const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);
const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 50)); } };

async function user(name: string, funded: number) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state)
    VALUES ($1, $2, $3, $4, '\\x00', 'KYC_VALIDATED')`, [id, crypto.randomUUID(), name, sha(name + '@example.test')]);
  const { resolvePointsOwner } = await import('../../src/application/services/pay/points-wallet-service.ts');
  const party = await resolvePointsOwner(pool, id);
  const client = await pool.connect();
  try { // Fixture funding only: bypass the projection guard for this insert.
    await client.query('BEGIN'); await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`INSERT INTO konektag.k_wallet_entries (party_id, operation_id, operation_type, direction, quantity_k, source_type, source_id)
      VALUES ($1, gen_random_uuid(), 'adjustment', 'credit', $2, 'test', 'fixture')`, [party, funded]);
    await client.query('COMMIT');
  } finally { client.release(); }
  return { id, email: name + '@example.test', party };
}

beforeAll(async () => {
  await frappeDouble('CONGO'); await frappeDouble('RESTODEMO');
  pool = (await import('../../src/infrastructure/database/pool.ts')).default;
  ({ POST: issue, GET: list } = await import('../../src/api/routes/integrations/frappe/payment-links.ts'));
  ({ POST: pay } = await import('../../src/api/routes/pay/pay-link.ts'));
  deliveries = await import('../../src/api/routes/integrations/frappe/link-pay/deliveries.ts');
  ({ siteWebhookService } = await import('../../src/application/link-pay/site-webhook-service.ts'));
  await pool.query(`INSERT INTO konektag.exchange_rates (from_currency, to_currency, rate, points_k_status, valid_from, valid_to,
      points_k_matrix_version, points_k_approval_source)
    SELECT 'XAF', 'EUR', 0.0015243902439024, 'APPROVED', '2026-01-01', '2027-12-31', 7, 'TEST'
    WHERE NOT EXISTS (SELECT 1 FROM konektag.exchange_rates WHERE from_currency='XAF' AND points_k_status='APPROVED')`);
});
afterAll(async () => { servers.forEach(s => s.close()); await pool?.end(); });
beforeEach(() => {
  for (const site of Object.values(sites)) { site.mode = 'up'; site.received = []; }
  sites.CONGO.terms = { RESTODEMO: approved('RESTODEMO'), CONGO: approved('CONGO') };
});

const key = () => crypto.randomBytes(32).toString('hex');

describe('Link Pay network collection on PostgreSQL', () => {
  it('merchant site: one link per attempt, debit once, network notified before the merchant', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.RESTODEMO.invoices[name] = invoice(name, 6500);
    const attempt = key();
    const first = await create('RESTODEMO', name, attempt);
    expect(first.status).toBe(201);
    const { link } = await first.json();
    expect(link).toMatchObject({ amount: 6500, currency: 'XAF', reference: name, beneficiary: { site: 'RESTODEMO' },
      network: { site: 'CONGO' }, fee: { mode: 'PERCENTAGE', rateBps: 250 } });
    expect(await (await create('RESTODEMO', name, attempt)).json()).toMatchObject({ link: { name: link.name } });
    expect(await count(`SELECT count(*) n FROM konektag.checkout_intents WHERE reference=$1`, [name])).toBe(1);
    // No merchant profile anywhere on this route.
    expect(await count(`SELECT count(*) n FROM konektag.checkout_intents WHERE public_id=$1 AND merchant_profile_id IS NULL
      AND collection_route='frappe_network'`, [link.name])).toBe(1);

    const payer = await user('payer-' + key().slice(0, 6), 100000);
    const paid = await payAs(payer, link.name);
    expect(paid.status).toBe(201);
    await settle();
    const [tx] = (await pool.query(`SELECT * FROM konektag.link_pay_network_transactions WHERE invoice=$1`, [name])).rows;
    expect(tx).toMatchObject({ currency: 'XAF', gross_minor: '6500', fee_minor: '163', net_minor: '6337', third_party: true });
    expect(sites.CONGO.received.map(p => p.roles)).toEqual([['network']]);
    expect(sites.RESTODEMO.received.map(p => p.roles)).toEqual([['beneficiary']]);
    expect(sites.RESTODEMO.received[0]).toMatchObject({ transactionId: tx.id, operationId: tx.k_operation_id, invoice: name,
      grossAmount: 6500, feeAmount: 163, netAmount: 6337 });

    // Replays: same payer, another payer, the worker. No second debit, transaction or delivery.
    expect((await payAs(payer, link.name)).status).toBe(201);
    const other = await user('other-' + key().slice(0, 6), 100000);
    expect((await payAs(other, link.name)).status).toBe(404); // already used, as for every link
    await siteWebhookService.processDue();
    expect(await count(`SELECT count(*) n FROM konektag.link_pay_network_transactions WHERE invoice=$1`, [name])).toBe(1);
    expect(await count(`SELECT count(*) n FROM konektag.k_operations k JOIN konektag.parties p ON p.id=k.party_id
      WHERE k.party_id IN ($1, $2)`, [payer.party, other.party])).toBe(1);
    expect(await count(`SELECT count(*) n FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1`, [tx.id])).toBe(2);
    expect(sites.CONGO.received.length + sites.RESTODEMO.received.length).toBe(2);
    const listed = await (await list(ctx('RESTODEMO', { query: '?invoice=' + encodeURIComponent(name) }))).json();
    expect(listed.links[0]).toMatchObject({ status: 'Used', operationId: tx.k_operation_id, transactionId: tx.id });
  });

  it('360°: Congo is network and beneficiary, one webhook carries both roles, nothing owed', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.CONGO.invoices[name] = invoice(name, 4000);
    const { link } = await (await create('CONGO', name, key())).json();
    const payer = await user('t-' + key().slice(0, 6), 100000);
    expect((await payAs(payer, link.name)).status).toBe(201);
    await settle();
    const [tx] = (await pool.query(`SELECT * FROM konektag.link_pay_network_transactions WHERE invoice=$1`, [name])).rows;
    expect(tx).toMatchObject({ gross_minor: '4000', fee_minor: '0', net_minor: '4000', third_party: false });
    expect(sites.CONGO.received.map(p => p.roles)).toEqual([['network', 'beneficiary']]);
    expect(sites.RESTODEMO.received).toEqual([]);
  });

  it('unavailable network: the merchant is never notified first, delivery resumes after the outage', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.RESTODEMO.invoices[name] = invoice(name, 1000);
    const { link } = await (await create('RESTODEMO', name, key())).json();
    sites.CONGO.mode = 'down';
    const payer = await user('d-' + key().slice(0, 6), 100000);
    expect((await payAs(payer, link.name)).status).toBe(201);
    await settle();
    const [tx] = (await pool.query(`SELECT id FROM konektag.link_pay_network_transactions WHERE invoice=$1`, [name])).rows;
    const states = async () => Object.fromEntries((await pool.query(
      `SELECT target_site, status FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1`, [tx.id])).rows
      .map((r: any) => [r.target_site, r.status]));
    expect(await states()).toEqual({ CONGO: 'failed', RESTODEMO: 'blocked' });
    expect(sites.RESTODEMO.received).toEqual([]);
    let listed = await (await list(ctx('RESTODEMO', { query: '?invoice=' + encodeURIComponent(name) }))).json();
    expect(listed.links[0]).toMatchObject({ status: 'Used', operationId: null });
    // A reply without acknowledgement is not a reception.
    sites.CONGO.mode = 'no-ack';
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id=$1`, [tx.id]);
    await siteWebhookService.processDue();
    expect(await states()).toEqual({ CONGO: 'failed', RESTODEMO: 'blocked' });
    sites.CONGO.mode = 'up';
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id=$1`, [tx.id]);
    await siteWebhookService.processDue();
    expect(await states()).toEqual({ CONGO: 'delivered', RESTODEMO: 'delivered' });
    expect(sites.RESTODEMO.received).toHaveLength(1);
    listed = await (await list(ctx('RESTODEMO', { query: '?invoice=' + encodeURIComponent(name) }))).json();
    expect(listed.links[0].operationId).toBeTruthy();
    // Dead letter after the outage: the network asks again, ordering is kept.
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET status='dead_lettered' WHERE transaction_id=$1 AND target_site='CONGO'`, [tx.id]);
    const again = await deliveries.POST({ request: new Request('http://x', { method: 'POST', body: JSON.stringify({ transactionId: tx.id }),
      headers: { 'X-Konektag-Frappe-Site': 'CONGO', 'X-Konektag-Frappe-Token': tokens.CONGO } }) } as any);
    expect(await again.json()).toEqual({ requeued: 1 });
    expect(await states()).toEqual({ CONGO: 'delivered', RESTODEMO: 'delivered' });
  });

  it('nothing is presumed: approval, fee rule and payout details are each required with their exact name', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.RESTODEMO.invoices[name] = invoice(name, 1000);
    const refused = async (terms: any) => { sites.CONGO.terms.RESTODEMO = terms; const r = await create('RESTODEMO', name, key()); return [r.status, await r.json()]; };
    expect(await refused(approved('RESTODEMO', { approved: 0 }))).toEqual([403, { error: 'BENEFICIARY_NOT_APPROVED', missing: ['collection_approved'] }]);
    expect(await refused(approved('RESTODEMO', { fee_mode: '', fee_rate_bps: 0 }))).toEqual([409, { error: 'BENEFICIARY_TERMS_INCOMPLETE', missing: ['fee_mode/fee_rate'] }]);
    expect(await refused(approved('RESTODEMO', { fee_mode: 'Percentage', fee_rate_bps: 0 }))).toEqual([409, { error: 'BENEFICIARY_TERMS_INCOMPLETE', missing: ['fee_mode/fee_rate'] }]);
    expect(await refused(approved('RESTODEMO', { payout_ready: 0 }))).toEqual([409, { error: 'BENEFICIARY_TERMS_INCOMPLETE', missing: ['payout_method + payout details'] }]);
    expect(await refused(approved('RESTODEMO', { country: 'FR' }))).toEqual([409, { error: 'INVOICE_CURRENCY_MISMATCH' }]);
    const r = await create('RESTODEMO', name, key(), 'RESTODEMO');
    expect([r.status, await r.json()]).toEqual([403, { error: 'NETWORK_SITE_NOT_ALLOWED' }]);
    expect(await count(`SELECT count(*) n FROM konektag.checkout_intents WHERE reference=$1`, [name])).toBe(0);
  });

  it('approval revoked after issuance: the client is not debited', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.RESTODEMO.invoices[name] = invoice(name, 1000);
    const { link } = await (await create('RESTODEMO', name, key())).json();
    sites.CONGO.terms.RESTODEMO = approved('RESTODEMO', { approved: 0 });
    const payer = await user('r-' + key().slice(0, 6), 100000);
    expect((await payAs(payer, link.name)).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM konektag.k_operations WHERE party_id=$1`, [payer.party])).toBe(0);
  });
});
