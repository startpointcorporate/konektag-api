/** Opt-in real ERPNext acceptance. Never included in the default unit suite.
 * Run the bundled file in the existing API pod: existing routing, PostgreSQL
 * lock and Frappe service tokens are reused. No API deployment is performed.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createPointsKQuotation } from '../../src/application/services/pay/points-k-quotation-service.ts';
import { routeKonektagFlow, konektagFrappeSite } from '../../src/application/shared/konektag-site.ts';
import type { FrappeSite } from '../../src/application/marketplace-transactions/frappe-site.ts';
import pool from '../../src/infrastructure/database/pool.ts';

if (process.env.KON68_ALLOW_SHARED_SITE_TEST_WRITES !== 'YES')
  throw new Error('Explicit authorization required: KON68_ALLOW_SHARED_SITE_TEST_WRITES=YES');
const runId = process.env.KON68_TEST_RUN_ID;
if (!runId || !/^[a-z0-9-]{8,64}$/.test(runId)) throw new Error('Explicit safe KON68_TEST_RUN_ID required');
const output = process.env.KON68_RESULT_PATH;
if (!output?.startsWith('/tmp/')) throw new Error('KON68_RESULT_PATH must be a private /tmp artifact');
const mapper = 'erpnext.selling.doctype.quotation.quotation.make_sales_order';
const expectedHosts: Record<string, string> = { FR: 'europe.erp.konektag.eu', CG: 'congo.erp.konektag.eu', LB: 'liban.erp.konektag.eu' };
const cases = [{ country: 'FR', currency: 'EUR', budget: 12.35 }, { country: 'CG', currency: 'XAF', budget: 9_300 }, { country: 'LB', currency: 'USD', budget: 12.50 }];
const results: any[] = [];
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const errorInfo = (e: any) => ({ name: e.name, code: e.code, httpStatus: e.httpStatus ?? e.detail?.httpStatus,
  excType: e.excType ?? e.detail?.excType, reason: e.detail?.reason,
  message: String(e.serverMessage ?? e.detail?.message ?? e.message).slice(0, 700) });
const total = (doc: any) => Number(Number(doc.disable_rounded_total) === 1 ? doc.grand_total : doc.rounded_total);

for (const test of cases) {
  const row: any = { ...test, runId, steps: {}, writes: [] }; results.push(row);
  let stage = 'routing';
  try {
    const route = await routeKonektagFlow('kon68-live-acceptance', test.country);
    const raw = konektagFrappeSite(route);
    check(raw.host === expectedHosts[test.country], 'Unexpected site: writes forbidden');
    row.host = raw.host; row.siteKey = raw.key;
    const hex = createHash('sha256').update('KON68-TEST|' + runId + '|' + test.country).digest('hex');
    const keycloakId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    row.keycloakFixtureId = keycloakId;
    const ownedLeads = new Set<string>(); const ownedQuotes = new Set<string>();
    const allow = async (doctype: string, name: string) => {
      if (doctype === 'Customer') check((await raw.get('Customer', name)).alias === keycloakId, 'Refuse unrelated Customer update');
      else if (doctype === 'Lead') check(ownedLeads.has(name), 'Refuse unrelated Lead update');
      else if (doctype === 'Quotation') check(ownedQuotes.has(name), 'Refuse unrelated Quotation update');
      else throw new Error('Unexpected write doctype: ' + doctype);
    };
    const site: FrappeSite = { ...raw,
      insert: async (doctype, doc) => {
        check(['Customer', 'Lead', 'Quotation'].includes(doctype), 'Unexpected API insert');
        if (doctype === 'Customer') check(doc.alias === keycloakId, 'Non-test Customer');
        if (doctype === 'Lead') check(String(doc.first_name).startsWith('KON68 TEST '), 'Non-test Lead');
        if (doctype === 'Quotation') {
          check(doc.quotation_to === 'Lead' && ownedLeads.has(String(doc.party_name)), 'Non-test Quotation');
          check(!('taxes' in doc) && !('grand_total' in doc) && !('rate' in (doc.items as any[])[0]), 'API supplied fiscal amounts');
        }
        const created = await raw.insert(doctype, doc);
        if (doctype === 'Lead') ownedLeads.add(created.name);
        if (doctype === 'Quotation') ownedQuotes.add(created.name);
        row.writes.push({ action: 'insert', doctype, name: created.name, docstatus: created.docstatus }); return created;
      },
      update: async (doctype, name, doc) => {
        await allow(doctype, name);
        check(doctype !== 'Sales Order', 'Sales Orders are never submitted');
        const updated = await raw.update(doctype, name, doc);
        row.writes.push({ action: 'update', doctype, name, docstatus: updated.docstatus }); return updated;
      },
      list: async (doctype, filters, fields, limit) => {
        const rows = await raw.list(doctype, filters, fields, limit);
        // Only previously owned fixture documents can enter the update path.
        if (doctype === 'Lead' && filters.some(f => f[0] === 'customer')) {
          for (const lead of rows) if ((await raw.get('Customer', lead.customer)).alias === keycloakId) ownedLeads.add(lead.name);
        }
        if (doctype === 'Quotation') for (const q of rows) {
          const doc = await raw.get('Quotation', q.name); if (ownedLeads.has(doc.party_name)) ownedQuotes.add(q.name);
        }
        return rows;
      },
      get: async (doctype, name) => {
        const doc = await raw.get(doctype, name);
        if (doctype === 'Lead' && doc.customer && (await raw.get('Customer', doc.customer)).alias === keycloakId) ownedLeads.add(doc.name);
        return doc;
      },
    };
    row.steps.routing = true;
    stage = 'api_first_call';
    const input = { ...test, keycloakId, displayName: `KON68 TEST ${runId} ${test.country}`, itemCode: 'POINTS-K' };
    const first = await createPointsKQuotation(input, { site: () => site }); row.first = first;
    row.steps.api_first_call = true;
    check(first.quotation.docstatus === 0, 'Quotation must start as draft');
    check(first.quotation.totalTaxesAndCharges > 0, 'Expected configured ERPNext taxes; silent zero forbidden');
    // A positive total alone would miss a dropped dependent levy (Congo).
    // Compare every native source row, without calculating or supplying tax.
    const item = await raw.get('Item', 'POINTS-K');
    const itemTemplate = item.taxes.find((t: any) => !t.tax_category)?.item_tax_template;
    check(itemTemplate, 'Points K has no automatic item tax template');
    const model = first.quotation.taxesAndCharges
      ? await raw.get('Sales Taxes and Charges Template', first.quotation.taxesAndCharges)
      : await raw.get('Item Tax Template', itemTemplate);
    const expectedAccounts = model.taxes.map((t: any) => t.account_head ?? t.tax_type);
    check(first.quotation.taxes.length === expectedAccounts.length, 'Native tax row count differs from source template');
    for (const source of model.taxes) {
      const actual = first.quotation.taxes.find(t => t.accountHead === (source.account_head ?? source.tax_type));
      check(actual && actual.taxAmount > 0, 'Native source tax account missing from quotation');
      if (source.charge_type) check(actual?.chargeType === source.charge_type, 'Compound tax method changed');
    }
    row.taxModel = { name: model.name, accounts: expectedAccounts };
    row.steps.native_taxes = true;
    stage = 'budget_boundary';
    const above = await site.update('Quotation', first.quotation.name, { items: [{ item_code: 'POINTS-K', qty: first.quotation.qty + 1, uom: 'Nos' }] });
    row.boundary = { qty: first.quotation.qty, total: first.quotation.total, nextQty: first.quotation.qty + 1, nextTotal: total(above), budget: test.budget };
    check(first.quotation.total <= test.budget && total(above) > test.budget, 'Maximum TTC budget boundary not satisfied');
    await site.update('Quotation', first.quotation.name, { items: [{ item_code: 'POINTS-K', qty: first.quotation.qty, uom: 'Nos' }] });
    row.steps.budget_boundary = true;
    stage = 'api_second_call';
    const second = await createPointsKQuotation(input, { site: () => site }); row.second = second;
    check(second.customer.name === first.customer.name && !second.customer.created, 'Customer not reused');
    check(second.lead.name === first.lead.name && !second.lead.created, 'Lead not reused');
    check(second.quotation.name === first.quotation.name && !second.quotation.created, 'Draft quotation not reused');
    row.steps.idempotence = true;
    const links = async () => {
      const customer = await raw.get('Customer', first.customer.name); const lead = await raw.get('Lead', first.lead.name);
      check(customer.alias === keycloakId && customer.lead_name === lead.name && lead.customer === customer.name, 'Native bidirectional identity linkage broken');
      check((await raw.list('Customer', [['alias', '=', keycloakId]], ['name'], 2)).length === 1, 'Alias duplicate');
      check((await raw.list('Customer', [['lead_name', '=', lead.name]], ['name'], 2)).length === 1, 'Lead ownership duplicate');
      return { customer: customer.name, alias: customer.alias, lead: lead.name, leadStatus: lead.status };
    };
    row.linksBeforeConversion = await links(); row.steps.customer_lead = true;
    stage = 'quotation_submit';
    const customerCountBefore = Number(await raw.call('frappe.client.get_count', { doctype: 'Customer' }));
    // Native mapper requires a submitted Quotation. Only this tagged test quote
    // is submitted; Sales Order stays draft; no invoice/payment is requested.
    await site.update('Quotation', first.quotation.name, { docstatus: 1 }); row.steps.quotation_submit = true;
    stage = 'native_sales_order_mapping';
    const mapped = await raw.call(mapper, { source_name: first.quotation.name });
    check(mapped.doctype === 'Sales Order' && Number(mapped.docstatus) === 0, 'Mapper returned a non-draft Sales Order');
    check(mapped.customer === first.customer.name, 'Native mapper created/resolved a different Customer');
    const customerCountAfter = Number(await raw.call('frappe.client.get_count', { doctype: 'Customer' }));
    check(customerCountAfter === customerCountBefore, 'Customer count changed during native conversion');
    row.linksAfterConversion = await links();
    row.conversion = { mappedCustomer: mapped.customer, customerCountBefore, customerCountAfter, mappedDocstatus: mapped.docstatus };
    row.steps.native_sales_order_mapping = true;
    stage = 'sales_order_draft_insert';
    const order = { ...mapped, docstatus: 0 };
    delete order.name;
    const q = await raw.get('Quotation', first.quotation.name);
    order.delivery_date = mapped.transaction_date ?? q.transaction_date;
    for (const item of order.items ?? []) item.delivery_date ||= order.delivery_date;
    const saved = await raw.insert('Sales Order', order);
    row.writes.push({ action: 'insert', doctype: 'Sales Order', name: saved.name, docstatus: saved.docstatus });
    check(Number(saved.docstatus) === 0 && saved.customer === first.customer.name, 'Saved Sales Order identity/status mismatch');
    row.salesOrder = { name: saved.name, customer: saved.customer, docstatus: saved.docstatus, currency: saved.currency, grandTotal: saved.grand_total };
    row.steps.sales_order_draft = true; row.passed = true;
  } catch (error) { row.passed = false; row.failure = { stage, ...errorInfo(error) }; }
  await writeFile(output, JSON.stringify({ runId, results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ country: test.country, passed: row.passed, steps: row.steps, failure: row.failure }));
}
await pool.end();
process.exitCode = results.every(r => r.passed) ? 0 : 1;
