import { describe, expect, it, vi } from 'vitest';
// Unit-only isolation: real production acceptance uses no module mocks.
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: { createWalletRechargeOrder: vi.fn(() => { throw new Error('Unexpected payment order creation'); }) },
}));
import { createPointsKCheckout, readPointsKCheckout } from '../../src/application/services/pay/points-k-checkout-service.ts';

const route: any = { site: 'EUROPE', slug: 'konektag-fr', paymentCountry: 'FR' };
function fixture(docstatus = 0) {
  const docs: Record<string, any> = {
    Customer: { CUST: { name: 'CUST', alias: 'kc', lead_name: 'LEAD' } },
    Quotation: { QTN: { name: 'QTN', docstatus, quotation_to: 'Lead', party_name: 'LEAD', currency: 'EUR',
      disable_rounded_total: 0, rounded_total: 12.21, items: [{ item_code: 'K', qty: 11 }] } },
  };
  const site: any = {
    key: 'EUROPE', host: 'erp.invalid',
    get: vi.fn(async (type: string, name: string) => docs[type]?.[name]),
    list: vi.fn(async (type: string) => type === 'Customer' ? [{ name: 'CUST' }]
      : type === 'Mode of Payment' ? [{ name: 'Carte', type: 'Bank', enabled: 1 }]
      : type === 'Sales Order' ? [] : type === 'Payment Request' ? [] : []),
    insert: vi.fn(async (type: string, doc: any) => type === 'Sales Order'
      ? { ...doc, name: 'SO', docstatus: 0 } : doc),
    call: vi.fn(async (method: string, args: any) => {
      if (method.endsWith('make_sales_order')) return { customer: 'CUST', currency: 'EUR', items: [{ prevdoc_docname: 'QTN' }] };
      if (method.endsWith('make_payment_request')) return { name: 'PR', docstatus: 1, reference_doctype: 'Sales Order', reference_name: 'SO', party: 'CUST', currency: 'EUR', grand_total: 12.21 };
      const doc = { ...args.doc, docstatus: 1 };
      if (doc.name === 'QTN') docs.Quotation.QTN = doc;
      return doc;
    }),
  };
  const context: any = { resolveForRoute: vi.fn(async () => ({ country: 'FR', konektagSite: 'konektag-fr', currency: 'EUR',
    legalEntity: { id: 'LE', code: 'FR', legalName: 'France' }, providers: [] })) };
  return { site, context };
}

describe('Points K flow 2', () => {
  it('exposes only an owned complete quotation and site payment modes', async () => {
    const f = fixture();
    const result = await readPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN' },
      { route: async () => route, site: () => f.site, context: f.context });
    expect(result.amount).toBe(12.21);
    expect(result.modesOfPayment).toEqual([{ name: 'Carte', type: 'Bank' }]);
  });

  it('submits the native chain and freezes ERPNext references in wallet metadata', async () => {
    const f = fixture();
    const createOrder = vi.fn(async (input: any) => ({ order: { id: 'order' }, checkoutToken: 'token', created: true, input }));
    const result = await createPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN', modeOfPayment: 'Carte' },
      { route: async () => route, site: () => f.site, context: f.context, createOrder: createOrder as any });
    expect(result).toMatchObject({ salesOrder: 'SO', paymentRequest: 'PR', amount: 12.21, amountMinor: 1221 });
    expect(createOrder.mock.calls[0][0]).toMatchObject({ amount: 1221, metadata: { erpnextPointsK: {
      version: 1, site: 'EUROPE', customer: 'CUST', quotation: 'QTN', salesOrder: 'SO', paymentRequest: 'PR', itemCode: 'K', quantityK: 11,
    } } });
  });
});
