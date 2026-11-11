/** Actual API service against native Frappe controllers in one real production
 * Bench transaction. The stdio adapter is transport, not a fake Frappe server.
 * Run locally with existing SSH access; no production credential is copied.
 * Payment-order creation is a throwing stop guard, never a fake success.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createPointsKCheckout } from '../../src/application/services/pay/points-k-checkout-service.ts';
import type { FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import { minorDigits } from '../../src/application/services/pay/money-unit.ts';

if (process.env.KON73_ALLOW_BENCH_ROLLBACK !== 'YES') throw new Error('Explicit rollback test opt-in required');
const outputPath = process.env.KON73_RESULT_PATH;
if (!outputPath?.startsWith('/tmp/')) throw new Error('Private /tmp result path required');
const routingPath = process.env.KON73_ROUTING_RESULT_PATH;
if (!routingPath?.startsWith('/tmp/')) throw new Error('Real HTTP route verification receipt required');
const verifiedRoutes = JSON.parse(readFileSync(routingPath, 'utf8'));
const source = readFileSync('tests/integration/points-k-checkout.bench.py', 'utf8');
const routes = [
  { country: 'FR', host: 'europe.erp.konektag.eu', site: 'EUROPE' },
  { country: 'CG', host: 'congo.erp.konektag.eu', site: 'KONEKTAG_CG' },
  { country: 'LB', host: 'liban.erp.konektag.eu', site: 'LIBAN' },
];
const check = (v: unknown, message: string) => { if (!v) throw new Error(message); };
const results: any[] = [];
for (const r of routes) {
  const verified = verifiedRoutes.find((x: any) => x.country === r.country);
  check(verified?.host === r.host && verified?.route?.site === r.site && verified?.http?.status === 200 && !verified.error, 'Unverified route');
  const row: any = { country: r.country, host: r.host, route: verified.route }; results.push(row);
  const child = spawn('ssh', ['-o', 'BatchMode=yes', 'konektag-core', `sudo -n k3s kubectl -n konektag-common exec -i deployment/konektag-erpnext-gunicorn -- bench --site ${r.host} console`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let resolveReady!: (v: any) => void;
  const ready = new Promise<any>(resolve => { resolveReady = resolve; });
  let resolveFinal!: (v: any) => void;
  const final = new Promise<any>(resolve => { resolveFinal = resolve; });
  const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
  const lines = createInterface({ input: child.stdout });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2000); });
  lines.on('line', line => {
    if (line.includes('KON73_RPC={')) {
      const data = JSON.parse(line.slice(line.indexOf('KON73_RPC=') + 'KON73_RPC='.length));
      if (data.id === 0) resolveReady(data.data);
      else { const p = pending.get(data.id); pending.delete(data.id); if (data.error) p?.reject(new Error(JSON.stringify(data.error))); else p?.resolve(data.data); }
    } else if (line.includes('KON73_BRIDGE_FINAL={')) {
      resolveFinal(JSON.parse(line.slice(line.indexOf('KON73_BRIDGE_FINAL=') + 'KON73_BRIDGE_FINAL='.length)));
    }
  });
  const call = (op: string, args: any = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
  });
  const timeout = setTimeout(() => { child.stdin.end(); child.kill('SIGTERM'); }, 90000);
  // JSON string literals are also Python string literals for this ASCII script.
  child.stdin.write(`exec(${JSON.stringify(source)}, {'KON73_ALLOW_NATIVE_ROLLBACK': True})\n`);
  try {
    const fixture = await Promise.race([ready, exited.then(() => { throw new Error('Bench exited before ready: ' + diagnostic); })]);
    const site: FrappeSite = { key: r.site, host: r.host,
      get: (doctype, name) => call('get', { doctype, name }),
      list: (doctype, filters, fields, limit = 100) => call('list', { doctype, filters, fields, limit }),
      insert: (doctype, doc) => call('insert', { doctype, doc }),
      update: async () => { throw new Error('Unexpected update'); },
      call: (method, params) => call('call', { method, params }),
    };
    const orderInputs: any[] = [];
    const boundary = new Error('KON73_STOP_BEFORE_PAYMENT_ORDER');
    const deps = { site: () => site,
      route: async () => verified.route,
      createOrder: async (input: any) => { orderInputs.push(input); throw boundary; },
    };
    const input = { country: r.country, userId: 'KON73_NO_DATABASE_WRITE', keycloakId: fixture.alias,
      customer: fixture.customer, quotation: fixture.quotation, modeOfPayment: 'Credit Card' };
    const snapshots = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await createPointsKCheckout(input, deps); throw new Error('Payment order guard was bypassed'); }
      catch (e) { if (e !== boundary) throw e; }
      snapshots.push(await call('inspect'));
    }
    check(JSON.stringify(snapshots[0]) === JSON.stringify(snapshots[1]), 'Replay changed native documents');
    check(JSON.stringify(orderInputs[0]) === JSON.stringify(orderInputs[1]), 'Replay changed metadata');
    check(orderInputs[0].amount === Math.round(fixture.expected_total * 10 ** minorDigits(fixture.currency)), 'Minor amount mismatch');
    const metadata = orderInputs[0].metadata.erpnextPointsK;
    check(metadata.customer === fixture.customer && metadata.quotation === fixture.quotation && metadata.site === r.site,
      'Metadata reference mismatch');
    const hashRef = (value: string) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    check(hashRef(metadata.salesOrder) === snapshots[0].refs_hashes['Sales Order']
      && hashRef(metadata.paymentRequest) === snapshots[0].refs_hashes['Payment Request'], 'Metadata SO/PR mismatch');
    row.apiServiceNative = snapshots[0];
    row.apiServiceReplayIdentical = true;
    row.boundaryMetadata = { version: metadata.version, site: metadata.site, itemCode: metadata.itemCode,
      quantityK: metadata.quantityK, amountMinor: orderInputs[0].amount, currency: orderInputs[0].currency,
      referencesMatch: true };
    row.stoppedBeforePostgresPaymentOrder = true;
  } catch (e: any) { row.error = e.message; }
  finally {
    if (child.exitCode === null) { await call('rollback').catch(() => {}); child.stdin.end(); }
    row.rollback = await Promise.race([final, exited.then(() => { throw new Error('Missing rollback receipt: ' + diagnostic); })]);
    await exited; clearTimeout(timeout);
    check(row.rollback.counts_identical && row.rollback.created_documents_absent && row.rollback.source_unchanged && row.rollback.series_unchanged, 'ROLLBACK_FAILED');
  }
  console.log(r.country + ': ' + (row.error ?? 'native API preparation + replay + rollback OK'));
}
writeFileSync(outputPath, JSON.stringify(results, null, 2) + '\n');
if (results.some(r => r.error)) process.exitCode = 1;
