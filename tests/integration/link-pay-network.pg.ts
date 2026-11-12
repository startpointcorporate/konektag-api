import { isolatedKUser } from '../helpers/isolated-k-wallet.ts';
// Link Pay through a network site, against a real PostgreSQL (all migrations including the API boundary fix) and two
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

async function user(_name: string, funded: number) { return isolatedKUser(pool, funded); }
async function saveTerms(raw: any) {
 await pool.query(`INSERT INTO konektag.link_pay_beneficiary_terms
 (network_site,beneficiary_site,beneficiary_name,enabled,approved,approved_by,approved_on,terms_hash,country,fee_mode,fee_rate_bps,payout_ready)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
 ON CONFLICT(network_site,beneficiary_site) DO UPDATE SET enabled=EXCLUDED.enabled,approved=EXCLUDED.approved,
 country=EXCLUDED.country,fee_mode=EXCLUDED.fee_mode,fee_rate_bps=EXCLUDED.fee_rate_bps,payout_ready=EXCLUDED.payout_ready`,
 [raw.network_site,raw.beneficiary_site,raw.beneficiary_name,Boolean(raw.enabled),Boolean(raw.approved),raw.approved_by,raw.approved_on,
 raw.terms_hash,raw.country,raw.fee_mode,raw.fee_rate_bps,Boolean(raw.payout_ready)]);
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
beforeEach(async () => {
  process.env.MARKETPLACE_FRAPPE_CONGO_API_KEY='k';
  for (const site of Object.values(sites)) { site.mode = 'up'; site.received = []; }
  sites.CONGO.terms={RESTODEMO:approved('RESTODEMO'),CONGO:approved('CONGO')};
  await saveTerms(approved('RESTODEMO')); await saveTerms(approved('CONGO'));
});

const key = () => crypto.randomBytes(32).toString('hex');

describe('Link Pay network collection on PostgreSQL', () => {
  it('merchant site: one link per attempt, debit once, merchant notified without network ERP', async () => {
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
    expect(sites.CONGO.received).toEqual([]);
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
    expect(await count(`SELECT count(*) n FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1`, [tx.id])).toBe(1);
    expect(sites.CONGO.received.length + sites.RESTODEMO.received.length).toBe(1);
    const listed = await (await list(ctx('RESTODEMO', { query: '?invoice=' + encodeURIComponent(name) }))).json();
    expect(listed.links[0]).toMatchObject({ status: 'Used', operationId: tx.k_operation_id, transactionId: tx.id });
  });

  it('360°: Congo is network and beneficiary, one merchant accounting webhook, nothing owed', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.CONGO.invoices[name] = invoice(name, 4000);
    const { link } = await (await create('CONGO', name, key())).json();
    const payer = await user('t-' + key().slice(0, 6), 100000);
    expect((await payAs(payer, link.name)).status).toBe(201);
    await settle();
    const [tx] = (await pool.query(`SELECT * FROM konektag.link_pay_network_transactions WHERE invoice=$1`, [name])).rows;
    expect(tx).toMatchObject({ gross_minor: '4000', fee_minor: '0', net_minor: '4000', third_party: false });
    expect(sites.CONGO.received.map(p => p.roles)).toEqual([['beneficiary']]);
    expect(sites.RESTODEMO.received).toEqual([]);
  });

  it('network ERP down: issuance, ledger finality and merchant notification stay operational', async () => {
    sites.CONGO.mode='down';
    delete process.env.MARKETPLACE_FRAPPE_CONGO_API_KEY;
    const name='ACC-SINV-'+key().slice(0,8);
    sites.RESTODEMO.invoices[name]=invoice(name,1000);
    const issued=await create('RESTODEMO',name,key()); expect(issued.status).toBe(201);
    const {link}=await issued.json(),payer=await user('outage',100000);
    expect((await payAs(payer,link.name)).status).toBe(201);await settle();
    expect(sites.CONGO.received).toEqual([]);expect(sites.RESTODEMO.received).toHaveLength(1);
    const listed=await(await list(ctx('RESTODEMO',{query:'?invoice='+name}))).json();
    expect(listed.links[0].operationId).toBeTruthy();expect(listed.links[0].paidAt).toBeTruthy();
    expect(await count(`SELECT count(*) n FROM konektag.outbox_events WHERE event_type='NetworkOperationChanged' AND payload->'operation'->>'reference'=$1`,[link.name])).toBe(0);
  });

  it('network ERP fails after issuance: a completed ledger payment is immediately visible to the merchant',async()=>{
    const name='ACC-SINV-'+key().slice(0,8);sites.RESTODEMO.invoices[name]=invoice(name,1000);
    const {link}=await(await create('RESTODEMO',name,key())).json();
    sites.CONGO.mode='down';
    const payer=await user('network-ack-failure',100000);
    expect((await payAs(payer,link.name)).status).toBe(201);await settle();
    const listed=await(await list(ctx('RESTODEMO',{query:'?invoice='+name}))).json();
    expect(listed.links[0].operationId).toBeTruthy();
    expect(sites.RESTODEMO.received).toHaveLength(1);
    expect(sites.CONGO.received).toHaveLength(0);
  });

  it('merchant ERP outage and missing ack: payment remains confirmed, accounting delivery retries once',async()=>{
    const name='ACC-SINV-'+key().slice(0,8);sites.RESTODEMO.invoices[name]=invoice(name,1000);
    const {link}=await(await create('RESTODEMO',name,key())).json();
    sites.RESTODEMO.mode='down';
    const payer=await user('retry',100000);
    const response=await payAs(payer,link.name);expect(response.status).toBe(201);await settle();
    const [tx]=(await pool.query('SELECT * FROM konektag.link_pay_network_transactions WHERE invoice=$1',[name])).rows;
    const state=async()=>(await pool.query('SELECT status,attempts FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1',[tx.id])).rows[0];
    expect((await state()).status).toBe('failed');
    const listed=await(await list(ctx('RESTODEMO',{query:'?invoice='+name}))).json();
    expect(listed.links[0]).toMatchObject({operationId:tx.k_operation_id,status:'Used'});
    const balance=await pool.query('SELECT * FROM konektag.points_balance($1)',[payer.party]);
    sites.RESTODEMO.mode='no-ack';
    await pool.query('UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id=$1',[tx.id]);
    await siteWebhookService.processDue();expect((await state()).status).toBe('failed');
    sites.RESTODEMO.mode='up';
    await pool.query('UPDATE konektag.link_pay_site_webhooks SET next_attempt_at=now() WHERE transaction_id=$1',[tx.id]);
    await Promise.all([siteWebhookService.processDue(),siteWebhookService.processDue()]);
    expect((await state()).status).toBe('delivered');
    await siteWebhookService.processDue();expect((await state()).attempts).toBe(3);
    expect((await pool.query('SELECT * FROM konektag.points_balance($1)',[payer.party])).rows).toEqual(balance.rows);
    expect((await payAs(payer,link.name)).status).toBe(201);
    expect(await count('SELECT count(*) n FROM konektag.link_pay_network_transactions WHERE invoice=$1',[name])).toBe(1);
  });

  it('upgrades historical blocked deliveries only after completed ledger proof; replay is harmless',async()=>{
    const name='ACC-SINV-'+key().slice(0,8);sites.RESTODEMO.invoices[name]=invoice(name,1000);
    const {link}=await(await create('RESTODEMO',name,key())).json();sites.RESTODEMO.mode='down';
    expect((await payAs(await user('legacy-migration',100000),link.name)).status).toBe(201);await settle();
    const [tx]=(await pool.query('SELECT * FROM konektag.link_pay_network_transactions WHERE invoice=$1',[name])).rows;
    const {readFile}=await import('node:fs/promises');
    const migration=await readFile('src/lib/infrastructure/database/migrations/239_link_pay_api_boundary.sql','utf8');
    const repair=migration.slice(migration.indexOf('-- Preserve old delivery history;'),migration.indexOf('COMMIT;'));
    const {rows:[network]}=await pool.query(`INSERT INTO konektag.link_pay_site_webhooks
     (transaction_id,target_site,roles,event_key,event_type,payload,status,next_attempt_at)
     VALUES($1,'CONGO',ARRAY['network'],$2,'link_pay.payment.succeeded','{}','failed',now()) RETURNING id`,[tx.id,'legacy-network:'+tx.id]);
    await pool.query(`UPDATE konektag.link_pay_site_webhooks SET status='blocked',depends_on=$2
     WHERE transaction_id=$1 AND target_site='RESTODEMO'`,[tx.id,network.id]);
    // A pending K operation cannot release merchant accounting. This is a rolled-back fixture only.
    const client=await pool.connect();
    try{
     await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');
     await client.query("UPDATE konektag.k_operations SET status='pending',completed_at=NULL WHERE id=$1",[tx.k_operation_id]);
     await client.query(repair);
     expect((await client.query("SELECT status FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1 AND target_site='RESTODEMO'",[tx.id])).rows[0].status).toBe('blocked');
    }finally{await client.query('ROLLBACK');client.release();}
    await pool.query(repair);await pool.query(repair);
    const rows=(await pool.query('SELECT target_site,status,depends_on FROM konektag.link_pay_site_webhooks WHERE transaction_id=$1',[tx.id])).rows;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({target_site:'CONGO',status:'cancelled'}),
     {target_site:'RESTODEMO',status:'pending',depends_on:null}]));
    sites.RESTODEMO.mode='up';await siteWebhookService.processDue();
    expect(sites.RESTODEMO.received).toHaveLength(1);expect(sites.CONGO.received).toHaveLength(0);
  });

  it('approval and payout readiness are enforced by API references, never inferred',async()=>{
    const name='ACC-SINV-'+key().slice(0,8);sites.RESTODEMO.invoices[name]=invoice(name,1000);
    await saveTerms(approved('RESTODEMO',{approved:0}));
    expect((await create('RESTODEMO',name,key())).status).toBe(403);
    await saveTerms(approved('RESTODEMO',{payout_ready:0}));
    expect((await create('RESTODEMO',name,key())).status).toBe(409);
    await pool.query("DELETE FROM konektag.link_pay_beneficiary_terms WHERE beneficiary_site='RESTODEMO'");
    expect((await create('RESTODEMO',name,key())).status).toBe(404);
    expect(await count('SELECT count(*) n FROM konektag.checkout_intents WHERE reference=$1',[name])).toBe(0);
  });

  it('imports existing approval evidence offline with audit, idempotence and stale-export rejection',async()=>{
    const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
    const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');
    const run=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'link-pay-approved-'));
    const path=join(dir,'approved.json');
    const row={...approved('IMPORTTEST'),approved_on:'2026-11-10T09:00:00Z',enabled:true,approved:true,payout_ready:true};
    try{
     await writeFile(path,JSON.stringify([row]),{mode:0o600});
     await run(process.execPath,['scripts/import-link-pay-terms.mjs',path]);
     const audits=async()=>count(`SELECT count(*) n FROM konektag.audit_logs WHERE event_type='LinkPayTermsImported' AND payload->'after'->>'beneficiary_site'='IMPORTTEST'`);
     const before=await audits();
     await run(process.execPath,['scripts/import-link-pay-terms.mjs',path]);expect(await audits()).toBe(before);
     const saved=(await pool.query("SELECT approved_by,terms_hash,approved FROM konektag.link_pay_beneficiary_terms WHERE beneficiary_site='IMPORTTEST'")).rows[0];
     expect(saved).toMatchObject({approved_by:row.approved_by,terms_hash:row.terms_hash,approved:true});
     await writeFile(path,JSON.stringify([{...row,approved_on:'2026-01-01T00:00:00Z'}]));
     await expect(run(process.execPath,['scripts/import-link-pay-terms.mjs',path])).rejects.toThrow('Stale approval export');
     expect(await audits()).toBe(before);
     await writeFile(path,JSON.stringify([{...row,approved:false,approved_by:null,approved_on:null,terms_hash:null}]));
     await run(process.execPath,['scripts/import-link-pay-terms.mjs',path]);
     expect((await pool.query("SELECT approved FROM konektag.link_pay_beneficiary_terms WHERE beneficiary_site='IMPORTTEST'")).rows[0].approved).toBe(false);
     expect(await audits()).toBe(before+1);
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  it('owner constraint: a historical link has exactly one owner, a network link none', async () => {
    const owner = await user('o-' + key().slice(0, 6), 1);
    const insert = (route: string | null, ownerId: string | null) => pool.query(
      `INSERT INTO konektag.checkout_intents (token_hash, amount, currency, expiration, source_type, public_id,
         owner_user_id, collection_route)
       VALUES ($1, 100, 'XAF', now() + interval '1 day', 'payment_link', $2, $3, $4)`,
      [key(), key().slice(0, 16), ownerId, route]);
    const rejected = (route: string | null, ownerId: string | null) =>
      insert(route, ownerId).then(() => null, (e: any) => e.constraint);
    // Historical link (collection_route NULL) with neither merchant nor owner: rejected.
    expect(await rejected(null, null)).toBe('checkout_intents_owner_check');
    // Network link carrying an owner: rejected.
    expect(await rejected('frappe_network', owner.id)).toBe('checkout_intents_owner_check');
    // Reference: a historical link with exactly one owner is still accepted.
    expect(await rejected(null, owner.id)).toBeNull();
  });

  it('consultation without merchant profiles: public page, payer read, resume and pending list', async () => {
    const { GET: read } = await import('../../src/api/routes/pay/payment-links.ts');
    const { POST: resume } = await import('../../src/api/routes/pay/payment-links/[slug]/resume.ts');
    const { GET: pending } = await import('../../src/api/routes/account/pending-transactions.ts');
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.CONGO.invoices[name] = invoice(name, 4000);
    const { link } = await (await create('CONGO', name, key())).json();
    const at = (user?: any) => read({ url: new URL('http://x/api/pay/payment-links?slug=' + link.name), locals: { user } } as any);
    expect((await (await at()).json()).links[0]).toMatchObject({ status: 'Active', etablissement: 'Konektag Congo', amount: 4000, currency: 'XAF', reference: name });
    const payer = await user('c-' + key().slice(0, 6), 100000);
    const mine = (await (await at({ id: payer.id })).json()).links[0];
    expect(mine).toMatchObject({ name: link.name, beneficiary: { site: 'CONGO', name: 'Konektag Congo' }, network: { site: 'CONGO' } });
    expect(mine.checkoutIntentId).toBeUndefined();
    expect((await resume({ locals: { user: payer }, params: { slug: link.name } } as any)).status).toBe(200);
    const listed = await (await pending({ locals: { user: payer }, url: new URL('http://x/api/account/pending-transactions') } as any)).json();
    expect(listed.transactions).toEqual(expect.arrayContaining([expect.objectContaining({ slug: link.name, label: 'Konektag Congo', type: 'payment_link' })]));
    expect((await payAs(payer, link.name)).status).toBe(201);
    expect((await (await at()).json()).links[0]).toEqual({ status: 'Used' });
  });

  it('approval revoked after issuance: the client is not debited', async () => {
    const name = 'ACC-SINV-' + key().slice(0, 8);
    sites.RESTODEMO.invoices[name] = invoice(name, 1000);
    const { link } = await (await create('RESTODEMO', name, key())).json();
    await saveTerms(approved('RESTODEMO', { approved: 0 }));
    const payer = await user('r-' + key().slice(0, 6), 100000);
    expect((await payAs(payer, link.name)).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM konektag.k_operations WHERE party_id=$1`, [payer.party])).toBe(0);
  });
});
