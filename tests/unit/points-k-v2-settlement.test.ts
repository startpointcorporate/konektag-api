import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/database/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import {
  erpMinor, payableMinor, PointsKSettlementError, readPointsKReference, resolveItemHandler,
  verifyErpnextChain, verifyPaymentEntry, verifySalesInvoice,
} from '../../src/application/services/pay/points-k-v2-settlement.ts';

const KEYCLOAK = 'kc-123';
const ref = { version: 1 as const, site: 'EUROPE', customer: 'CUST-1', quotation: 'QTN-1', salesOrder: 'SO-1', paymentRequest: 'PR-1', itemCode: 'POINTS-K' };
const item = { item_code: 'POINTS-K', qty: 83, conversion_factor: 1, net_amount: 83 };
const totals = { currency: 'EUR', grand_total: 99.6, rounded_total: 0, disable_rounded_total: 1 };
const chain = () => ({
  customer: { name: 'CUST-1', alias: KEYCLOAK, disabled: 0 },
  quotation: { name: 'QTN-1', docstatus: 1, ...totals, items: [{ ...item }] },
  salesOrder: { name: 'SO-1', docstatus: 1, customer: 'CUST-1', ...totals, items: [{ ...item, prevdoc_docname: 'QTN-1' }] },
  paymentRequest: { name: 'PR-1', docstatus: 1, status: 'Initiated', reference_doctype: 'Sales Order', reference_name: 'SO-1',
    party_type: 'Customer', party: 'CUST-1', payment_request_type: 'Inward', currency: 'EUR', grand_total: 99.6 },
});
const proof = { currency: 'EUR', confirmedMinor: 9960, keycloakId: KEYCLOAK };
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as PointsKSettlementError).code; } return 'OK'; };

describe('Points K V2 settlement checks', () => {
  it('leaves every order without an ERPNext reference to its existing circuit', () => {
    expect(readPointsKReference({})).toBeNull();
    expect(readPointsKReference({ konektagSite: { slug: 'konektag-fr' } })).toBeNull();
    expect(readPointsKReference(null)).toBeNull();
    expect(readPointsKReference({ erpnextPointsK: ref })).toEqual(ref);
    expect(code(() => readPointsKReference({ erpnextPointsK: { ...ref, site: 'europe' } }))).toBe('REFERENCE_INVALID');
    expect(code(() => readPointsKReference({ erpnextPointsK: { ...ref, extra: 1 } }))).toBe('REFERENCE_INVALID');
  });

  it('dispatches by configured item_code only', () => {
    const env = { ERPNEXT_ITEM_HANDLERS: '{"POINTS-K":"points_k","OTHER":"boost"}' };
    expect(resolveItemHandler('POINTS-K', env)).toBe('points_k');
    expect(code(() => resolveItemHandler('OTHER', env))).toBe('HANDLER_NOT_CONFIGURED');
    expect(code(() => resolveItemHandler('POINTS-K', {}))).toBe('HANDLER_NOT_CONFIGURED');
    expect(code(() => resolveItemHandler('toString', {}))).toBe('HANDLER_NOT_CONFIGURED');
    expect(code(() => resolveItemHandler('POINTS-K', { ERPNEXT_ITEM_HANDLERS: '{' }))).toBe('HANDLER_NOT_CONFIGURED');
  });

  it('converts ERPNext amounts to minor units without rounding a fraction away', () => {
    expect(erpMinor(99.6, 'EUR')).toBe(9960);
    expect(erpMinor('7730', 'XAF')).toBe(7730);
    expect(code(() => erpMinor(7729.5, 'XAF'))).toBe('AMOUNT_MISMATCH');
    expect(code(() => erpMinor(0, 'EUR'))).toBe('AMOUNT_MISMATCH');
    expect(payableMinor({ currency: 'XAF', grand_total: 7728.95, rounded_total: 7730, disable_rounded_total: 0 })).toBe(7730);
    expect(payableMinor({ currency: 'EUR', grand_total: 99.6, rounded_total: 100, disable_rounded_total: 1 })).toBe(9960);
  });

  it('takes the K quantity from the Quotation item, never from the TTC or currency amount', () => {
    expect(verifyErpnextChain(ref, chain(), proof)).toEqual({ quantityK: 83, netMinor: 8300 });
    const cg = chain();
    for (const doc of [cg.quotation, cg.salesOrder]) Object.assign(doc, { currency: 'XAF', grand_total: 7728.95, rounded_total: 7730, disable_rounded_total: 0 });
    for (const row of [cg.quotation.items[0], cg.salesOrder.items[0]]) Object.assign(row, { qty: 10, net_amount: 6550 });
    Object.assign(cg.paymentRequest, { currency: 'XAF', grand_total: 7730 });
    expect(verifyErpnextChain(ref, cg, { currency: 'XAF', confirmedMinor: 7730, keycloakId: KEYCLOAK })).toEqual({ quantityK: 10, netMinor: 6550 });
  });

  it.each([
    ['provider amount differs from the Payment Request', (c: any) => c, { confirmedMinor: 8300 }, 'AMOUNT_MISMATCH'],
    ['provider currency differs', (c: any) => c, { currency: 'USD' }, 'DOCUMENT_MISMATCH'],
    ['Customer of another user', (c: any) => { c.customer.alias = 'other'; return c; }, {}, 'OWNER_MISMATCH'],
    ['draft Quotation', (c: any) => { c.quotation.docstatus = 0; return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['fractional K', (c: any) => { c.quotation.items[0].qty = 82.5; return c; }, {}, 'QUANTITY_INVALID'],
    ['UOM conversion', (c: any) => { c.quotation.items[0].conversion_factor = 10; return c; }, {}, 'QUANTITY_INVALID'],
    ['other item in the Quotation', (c: any) => { c.quotation.items.push({ item_code: 'X', qty: 1 }); return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['Sales Order not made from the Quotation', (c: any) => { c.salesOrder.items[0].prevdoc_docname = 'QTN-2'; return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['Sales Order quantity differs', (c: any) => { c.salesOrder.items[0].qty = 84; return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['Payment Request on another Sales Order', (c: any) => { c.paymentRequest.reference_name = 'SO-2'; return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['cancelled Payment Request', (c: any) => { c.paymentRequest.status = 'Cancelled'; return c; }, {}, 'DOCUMENT_MISMATCH'],
    ['outward Payment Request', (c: any) => { c.paymentRequest.payment_request_type = 'Outward'; return c; }, {}, 'DOCUMENT_MISMATCH'],
  ])('refuses %s', (_label, alter, override, expected) => {
    expect(code(() => verifyErpnextChain(ref, alter(chain()), { ...proof, ...override }))).toBe(expected);
  });

  it('rejects an invoice or a payment that does not match the settlement', () => {
    const s = { currency: 'EUR', confirmed_minor: '9960', quantity_k: '83', provider_reference: 'pi_1' };
    const si = { name: 'SI-1', docstatus: 1, customer: 'CUST-1', ...totals, items: [{ ...item, sales_order: 'SO-1' }] };
    expect(code(() => verifySalesInvoice(si, ref, s))).toBe('OK');
    expect(code(() => verifySalesInvoice({ ...si, docstatus: 2 }, ref, s))).toBe('DOCUMENT_MISMATCH');
    expect(code(() => verifySalesInvoice({ ...si, is_return: 1 }, ref, s))).toBe('DOCUMENT_MISMATCH');
    expect(code(() => verifySalesInvoice({ ...si, grand_total: 100 }, ref, s))).toBe('AMOUNT_MISMATCH');
    const pe = { name: 'PE-1', docstatus: 1, payment_type: 'Receive', party_type: 'Customer', party: 'CUST-1', reference_no: 'pi_1', paid_amount: 99.6,
      references: [{ reference_doctype: 'Sales Invoice', reference_name: 'SI-1', allocated_amount: 99.6 }] };
    expect(code(() => verifyPaymentEntry(pe, ref, s, 'SI-1'))).toBe('OK');
    expect(code(() => verifyPaymentEntry({ ...pe, reference_no: 'pi_2' }, ref, s, 'SI-1'))).toBe('DOCUMENT_MISMATCH');
    expect(code(() => verifyPaymentEntry({ ...pe, paid_amount: 83 }, ref, s, 'SI-1'))).toBe('AMOUNT_MISMATCH');
    expect(code(() => verifyPaymentEntry({ ...pe, references: [{ ...pe.references[0], reference_doctype: 'Sales Order' }] }, ref, s, 'SI-1'))).toBe('DOCUMENT_MISMATCH');
  });
});
