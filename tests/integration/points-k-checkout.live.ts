/** Read-only production acceptance. Uses existing service credentials in API pod.
 * No mocks, no checkout POST, no database migrations or payment order creation.
 * Bundle with esbuild (packages external) and run under /tmp in existing API pod.
 */
import { GET } from '../../src/api/routes/points-k/checkout.ts';
import { readPointsKCheckout } from '../../src/application/services/pay/points-k-checkout-service.ts';
import { routeKonektagFlow, konektagFrappeSite } from '../../src/application/shared/konektag-site.ts';
import pool from '../../src/infrastructure/database/pool.ts';
const fixtures = [
  { country: 'FR', host: 'europe.erp.konektag.eu', alias: 'cb19d1b0-1787-491e-abbf-d9a385c6ae19', total: 12, currency: 'EUR' },
  { country: 'CG', host: 'congo.erp.konektag.eu', alias: '805b13b8-3a20-407f-aef4-9a4b52416079', total: 8567, currency: 'XAF' },
  { country: 'LB', host: 'liban.erp.konektag.eu', alias: '8e9ccf2e-d8e9-4abc-ae06-275aecddfb41', total: 12.21, currency: 'USD' },
];
const check = (v: unknown, message: string) => { if (!v) throw new Error(message); };
const error = (e: any) => ({ code: e.code ?? e.message, httpStatus: e.httpStatus, excType: e.excType });
const rows: any[] = [];
try {
  for (const f of fixtures) {
    const r: any = { country: f.country }; rows.push(r);
    try {
      const route = await routeKonektagFlow('kon73-read-only', f.country);
      const site = konektagFrappeSite(route);
      check(site.host === f.host, 'UNEXPECTED_HOST');
      r.route = route; r.host = site.host;
      r.authenticatedUser = await site.call('frappe.auth.get_logged_user', {});
      const customers = await site.list('Customer', [['alias', '=', f.alias]], ['name', 'alias', 'lead_name'], 2);
      check(customers.length === 1, 'TEST_CUSTOMER_NOT_UNIQUE');
      const c = customers[0];
      const input = { keycloakId: f.alias, userId: 'KON73_READ_ONLY_NO_ORDER', country: f.country, customer: c.name, quotation: 'SAL-QTN-2026-00003' };
      const q = await site.get('Quotation', input.quotation);
      check(q.quotation_to === 'Lead' && q.party_name === c.lead_name, 'QUOTATION_OWNER_MISMATCH');
      const ttc = Number(Number(q.disable_rounded_total) === 1 ? q.grand_total : q.rounded_total);
      check(ttc === f.total && q.currency === f.currency, 'TTC_OR_CURRENCY_MISMATCH');
      r.nativeQuotation = { docstatus: q.docstatus, amount: ttc, currency: q.currency, netTotal: q.net_total,
        grandTotal: q.grand_total, roundedTotal: q.rounded_total,
        taxes: q.taxes.map((t: any) => ({ chargeType: t.charge_type, amount: t.tax_amount })) };
      r.attempts = [];
      for (let i = 0; i < 2; i++) {
        try { const result = await readPointsKCheckout(input); r.attempts.push({ ok: true, amount: result.amount }); }
        catch (e) { r.attempts.push(error(e)); }
      }
      const http = await GET({ url: new URL('https://local.invalid/api/points-k/checkout?' + new URLSearchParams({ country: f.country, customer: c.name, quotation: input.quotation })), locals: { user: { id: input.userId, keycloak_id: f.alias } } } as any);
      r.http = { status: http.status, body: await http.json() };
      r.modes = await site.list('Mode of Payment', [['enabled', '=', 1]], ['name', 'type'], 100);
      r.profiles = await site.list('Konektag Regulatory Profile', [], ['name', 'status', 'runtime_operation', 'rail', 'valid_from', 'valid_until'], 100);
      r.corridors = await site.list('Konektag Corridor', [], ['name', 'status', 'corridor_code'], 100);
      try { await readPointsKCheckout({ ...input, keycloakId: 'KON73_WRONG_OWNER' }); throw new Error('OWNERSHIP_ACCEPTED'); }
      catch (e: any) { check(e.code === 'CUSTOMER_NOT_OWNED', 'OWNERSHIP_UNEXPECTED_ERROR'); r.ownershipRejected = true; }
      r.gatewayAccounts = await site.list('Payment Gateway Account', [], ['name', 'payment_channel', 'is_default', 'currency'], 100);
      r.salesOrders = (await site.list('Sales Order', [['customer', '=', c.name]], ['name', 'docstatus', 'currency', 'grand_total', 'rounded_total'], 100)).map(({ name, ...doc }) => doc);
      r.paymentRequests = await site.list('Payment Request', [['party', '=', c.name]], ['name', 'docstatus'], 100);
      check((await site.get('Customer', c.name)).alias === f.alias, 'CUSTOMER_CHANGED');
      r.customerUnchanged = true;
    } catch (e) { r.error = error(e); }
  }
  console.log('KON73_RESULT=' + JSON.stringify(rows));
} finally { await pool.end(); }
